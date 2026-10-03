import { PlanError } from "./errors.ts";

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
};

export function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

export function attr(el: XmlNode, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(el.attrs, name)) return el.attrs[name];
  for (const [key, value] of Object.entries(el.attrs)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

export function parseXml(xml: string): XmlNode {
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;

  function fail(message: string): never {
    const line = xml.slice(0, i).split("\n").length;
    throw new PlanError(`${message} (line ${line})`);
  }

  function skipUntil(close: string): void {
    const at = xml.indexOf(close, i);
    if (at < 0) fail(`unclosed ${close}`);
    i = at + close.length;
  }

  function readName(): string {
    const start = i;
    while (i < xml.length && /[A-Za-z0-9:_.-]/.test(xml[i] ?? "")) i += 1;
    if (i === start) fail("expected a name");
    return xml.slice(start, i);
  }

  function skipSpace(): void {
    while (i < xml.length) {
      const c = xml[i];
      if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") break;
      i += 1;
    }
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipSpace();
      if (i >= xml.length) fail("unterminated start tag");
      const c = xml[i];
      if (c === ">" || c === "/" || c === "?") break;
      const name = readName();
      skipSpace();
      if (xml[i] !== "=") fail(`expected = after ${name}`);
      i += 1;
      skipSpace();
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") fail(`expected a quote after ${name}`);
      i += 1;
      const start = i;
      while (i < xml.length && xml[i] !== quote) i += 1;
      if (xml[i] !== quote) fail(`unclosed attribute ${name}`);
      attrs[name] = decodeEntities(xml.slice(start, i));
      i += 1;
    }
    return attrs;
  }

  function parseNodes(): XmlNode[] {
    const nodes: XmlNode[] = [];
    while (i < xml.length) {
      if (xml[i] !== "<") {
        while (i < xml.length && xml[i] !== "<") i += 1;
        continue;
      }
      if (xml.startsWith("<!--", i)) {
        skipUntil("-->");
        continue;
      }
      if (xml.startsWith("<?", i)) {
        skipUntil("?>");
        continue;
      }
      if (xml.startsWith("<![CDATA[", i)) {
        skipUntil("]]>");
        continue;
      }
      if (xml.startsWith("<!", i)) {
        skipUntil(">");
        continue;
      }
      if (xml.startsWith("</", i)) break;
      nodes.push(parseElement());
    }
    return nodes;
  }

  function parseElement(): XmlNode {
    i += 1;
    const name = readName();
    const attrs = parseAttrs();
    if (xml.startsWith("/>", i)) {
      i += 2;
      return { name, attrs, children: [] };
    }
    if (xml[i] !== ">") fail(`expected > after <${name}>`);
    i += 1;
    const children = parseNodes();
    if (!xml.startsWith("</", i)) fail(`unclosed <${name}>`);
    i += 2;
    const end = readName();
    if (end !== name) fail(`</${end}> does not close <${name}>`);
    skipSpace();
    if (xml[i] !== ">") fail(`expected > after </${end}>`);
    i += 1;
    return { name, attrs, children };
  }

  const roots = parseNodes().filter((node) => localName(node.name) === "svg");
  if (roots.length !== 1) fail("SVG document needs one svg root");
  return roots[0]!;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|amp|lt|gt|apos);/g, (all, entity: string) => {
    switch (entity) {
      case "quot":
        return '"';
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "apos":
        return "'";
      default: {
        const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        if (!Number.isFinite(code)) return all;
        return String.fromCodePoint(code);
      }
    }
  });
}
