/**
 * A small XML reader and writer.
 *
 * ICDD documents are RDF/XML, so the package needs XML support — but the platform carries no
 * runtime dependencies, and pulling in a general parser to read four well-known document shapes
 * would be a poor trade. This handles the subset RDF/XML actually uses: elements, attributes,
 * namespaces, text, CDATA and comments.
 *
 * Deliberately **not** supported: DTDs, entity declarations, processing instructions beyond the
 * XML declaration, and mixed-content whitespace preservation. A document using them is rejected
 * rather than silently mis-parsed.
 */

export interface XmlElement {
  /** Resolved namespace IRI, or `undefined` for an element in no namespace. */
  readonly namespace: string | undefined;
  readonly localName: string;
  readonly qualifiedName: string;
  /** Attributes keyed by `namespace + localName` for namespaced ones, `localName` otherwise. */
  readonly attributes: ReadonlyMap<string, string>;
  /** Namespace declarations introduced by this element, prefix -> IRI (`""` for default). */
  readonly namespaces: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text content, entity-decoded. */
  readonly text: string;
}

export class XmlError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (at character ${position})`);
    this.name = "XmlError";
    this.position = position;
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function escapeText(input: string): string {
  return input.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
}

export function escapeAttribute(input: string): string {
  return escapeText(input).replace(/"/g, "&quot;");
}

interface MutableElement {
  namespace: string | undefined;
  localName: string;
  qualifiedName: string;
  attributes: Map<string, string>;
  namespaces: Map<string, string>;
  children: MutableElement[];
  text: string;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

export function parseXml(source: string): XmlElement {
  let position = 0;
  const scopes: Map<string, string>[] = [new Map([["xml", "http://www.w3.org/XML/1998/namespace"]])];

  const fail = (message: string): never => {
    throw new XmlError(message, position);
  };

  const lookup = (prefix: string): string | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const found = scopes[i]?.get(prefix);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const skipWhitespace = (): void => {
    while (position < source.length && /\s/.test(source[position] ?? "")) position++;
  };

  const readName = (): string => {
    const start = position;
    if (!NAME_START.test(source[position] ?? "")) fail("Expected an element or attribute name");
    while (position < source.length && NAME_CHAR.test(source[position] ?? "")) position++;
    return source.slice(start, position);
  };

  /** Consumes comments, the XML declaration and CDATA; returns text picked up along the way. */
  const consumeMarkupNoise = (): string | undefined => {
    if (source.startsWith("<!--", position)) {
      const end = source.indexOf("-->", position);
      if (end === -1) fail("Unterminated comment");
      position = end + 3;
      return undefined;
    }
    if (source.startsWith("<?", position)) {
      const end = source.indexOf("?>", position);
      if (end === -1) fail("Unterminated processing instruction");
      position = end + 2;
      return undefined;
    }
    if (source.startsWith("<![CDATA[", position)) {
      const end = source.indexOf("]]>", position);
      if (end === -1) fail("Unterminated CDATA section");
      const content = source.slice(position + 9, end);
      position = end + 3;
      return content; // CDATA is literal: no entity decoding
    }
    if (source.startsWith("<!", position)) {
      fail("Document type declarations are not supported");
    }
    return undefined;
  };

  const parseElement = (): MutableElement => {
    position++; // consume '<'
    const qualifiedName = readName();

    const rawAttributes = new Map<string, string>();
    const namespaces = new Map<string, string>();

    for (;;) {
      skipWhitespace();
      const char = source[position];
      if (char === undefined) fail("Unexpected end of document inside a tag");
      if (char === ">" || char === "/") break;

      const attributeName = readName();
      skipWhitespace();
      if (source[position] !== "=") fail(`Attribute "${attributeName}" has no value`);
      position++;
      skipWhitespace();
      const quote = source[position];
      if (quote !== '"' && quote !== "'") fail(`Attribute "${attributeName}" value is not quoted`);
      position++;
      const valueStart = position;
      while (position < source.length && source[position] !== quote) position++;
      if (position >= source.length) fail(`Unterminated value for attribute "${attributeName}"`);
      const value = decodeEntities(source.slice(valueStart, position));
      position++;

      if (attributeName === "xmlns") namespaces.set("", value);
      else if (attributeName.startsWith("xmlns:")) namespaces.set(attributeName.slice(6), value);
      else rawAttributes.set(attributeName, value);
    }

    scopes.push(namespaces);

    const colon = qualifiedName.indexOf(":");
    const prefix = colon === -1 ? "" : qualifiedName.slice(0, colon);
    const localName = colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
    const namespace = lookup(prefix);
    if (prefix !== "" && namespace === undefined) {
      scopes.pop();
      fail(`Undeclared namespace prefix "${prefix}"`);
    }

    // Attribute names resolve against declared prefixes; an unprefixed attribute is in no
    // namespace, which is why the default namespace is deliberately not applied here.
    const attributes = new Map<string, string>();
    for (const [name, value] of rawAttributes) {
      const attributeColon = name.indexOf(":");
      if (attributeColon === -1) {
        attributes.set(name, value);
        continue;
      }
      const attributePrefix = name.slice(0, attributeColon);
      const attributeLocal = name.slice(attributeColon + 1);
      const attributeNamespace = lookup(attributePrefix);
      if (attributeNamespace === undefined) {
        scopes.pop();
        fail(`Undeclared namespace prefix "${attributePrefix}"`);
      }
      attributes.set(`${attributeNamespace}${attributeLocal}`, value);
    }

    const element: MutableElement = {
      namespace,
      localName,
      qualifiedName,
      attributes,
      namespaces,
      children: [],
      text: "",
    };

    if (source[position] === "/") {
      position += 2; // '/>'
      scopes.pop();
      return element;
    }
    position++; // '>'

    for (;;) {
      if (position >= source.length) fail(`Unclosed element "${qualifiedName}"`);

      if (source[position] === "<") {
        if (source.startsWith("</", position)) {
          position += 2;
          const closing = readName();
          if (closing !== qualifiedName) fail(`Expected </${qualifiedName}> but found </${closing}>`);
          skipWhitespace();
          if (source[position] !== ">") fail("Malformed closing tag");
          position++;
          break;
        }
        const noise = consumeMarkupNoise();
        if (noise !== undefined) {
          element.text += noise;
          continue;
        }
        if (source[position] === "<") {
          element.children.push(parseElement());
          continue;
        }
        continue;
      }

      const nextTag = source.indexOf("<", position);
      const end = nextTag === -1 ? source.length : nextTag;
      element.text += decodeEntities(source.slice(position, end));
      position = end;
    }

    scopes.pop();
    return element;
  };

  skipWhitespace();
  while (position < source.length && source[position] === "<" && !NAME_START.test(source[position + 1] ?? "")) {
    consumeMarkupNoise();
    skipWhitespace();
  }
  if (position >= source.length || source[position] !== "<") fail("No root element found");
  const root = parseElement();
  return root as XmlElement;
}

export interface XmlWriterOptions {
  /** Prefix -> namespace IRI, declared on the root element. */
  readonly prefixes?: Readonly<Record<string, string>>;
  readonly indent?: string;
}

export interface XmlNodeInput {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | undefined>>;
  readonly children?: readonly XmlNodeInput[];
  readonly text?: string;
}

/** Serialises a node tree. Names are written as supplied — callers pass qualified names. */
export function writeXml(root: XmlNodeInput, options: XmlWriterOptions = {}): string {
  const indent = options.indent ?? "  ";
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  const rootAttributes: Record<string, string | undefined> = { ...(root.attributes ?? {}) };
  for (const [prefix, iri] of Object.entries(options.prefixes ?? {})) {
    rootAttributes[prefix === "" ? "xmlns" : `xmlns:${prefix}`] = iri;
  }

  const write = (node: XmlNodeInput, attributes: Record<string, string | undefined>, depth: number): void => {
    const pad = indent.repeat(depth);
    const parts = Object.entries(attributes)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${name}="${escapeAttribute(value)}"`);
    const open = parts.length > 0 ? `${node.name} ${parts.join(" ")}` : node.name;

    const children = node.children ?? [];
    const hasText = node.text !== undefined && node.text !== "";

    if (children.length === 0 && !hasText) {
      lines.push(`${pad}<${open}/>`);
      return;
    }
    if (children.length === 0 && hasText) {
      lines.push(`${pad}<${open}>${escapeText(node.text ?? "")}</${node.name}>`);
      return;
    }
    lines.push(`${pad}<${open}>`);
    for (const child of children) write(child, { ...(child.attributes ?? {}) }, depth + 1);
    lines.push(`${pad}</${node.name}>`);
  };

  write(root, rootAttributes, 0);
  return `${lines.join("\n")}\n`;
}

/** Depth-first search for the first descendant matching a namespace and local name. */
export function findElement(
  element: XmlElement,
  namespace: string | undefined,
  localName: string,
): XmlElement | undefined {
  if (element.namespace === namespace && element.localName === localName) return element;
  for (const child of element.children) {
    const found = findElement(child, namespace, localName);
    if (found) return found;
  }
  return undefined;
}
