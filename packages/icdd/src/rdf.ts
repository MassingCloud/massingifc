import { NS } from "./ontology.js";
import { parseXml, writeXml, type XmlElement, type XmlNodeInput } from "./xml.js";

/**
 * A minimal RDF graph and RDF/XML codec.
 *
 * Only what ICDD needs: named nodes, blank nodes, plain and typed literals, and the striped
 * RDF/XML serialisation that `index.rdf` and linkset documents use. Collections, containers,
 * reification and `rdf:parseType` are out of scope and are reported rather than skipped, so a
 * document this code cannot faithfully represent never round-trips into something subtly wrong.
 */

export interface NamedNode {
  readonly termType: "NamedNode";
  readonly value: string;
}

export interface BlankNode {
  readonly termType: "BlankNode";
  readonly value: string;
}

export interface Literal {
  readonly termType: "Literal";
  readonly value: string;
  readonly datatype?: string;
  readonly language?: string;
}

export type Term = NamedNode | BlankNode | Literal;
export type SubjectTerm = NamedNode | BlankNode;

export const namedNode = (value: string): NamedNode => ({ termType: "NamedNode", value });
export const blankNode = (value: string): BlankNode => ({ termType: "BlankNode", value });
export const literal = (value: string, options: { datatype?: string; language?: string } = {}): Literal => ({
  termType: "Literal",
  value,
  ...(options.datatype === undefined ? {} : { datatype: options.datatype }),
  ...(options.language === undefined ? {} : { language: options.language }),
});

export interface Quad {
  readonly subject: SubjectTerm;
  readonly predicate: string;
  readonly object: Term;
}

const termKey = (term: Term): string =>
  term.termType === "Literal"
    ? `L:${term.value}|${term.datatype ?? ""}|${term.language ?? ""}`
    : `${term.termType === "BlankNode" ? "B" : "N"}:${term.value}`;

export class Graph {
  readonly #quads: Quad[] = [];
  readonly #seen = new Set<string>();
  readonly #bySubject = new Map<string, Quad[]>();

  get size(): number {
    return this.#quads.length;
  }

  get quads(): readonly Quad[] {
    return this.#quads;
  }

  add(subject: SubjectTerm, predicate: string, object: Term): this {
    const key = `${termKey(subject)}|${predicate}|${termKey(object)}`;
    if (this.#seen.has(key)) return this; // a set of triples, not a bag
    this.#seen.add(key);
    const quad: Quad = { subject, predicate, object };
    this.#quads.push(quad);
    const subjectKey = termKey(subject);
    const bucket = this.#bySubject.get(subjectKey);
    if (bucket) bucket.push(quad);
    else this.#bySubject.set(subjectKey, [quad]);
    return this;
  }

  addAll(quads: Iterable<Quad>): this {
    for (const quad of quads) this.add(quad.subject, quad.predicate, quad.object);
    return this;
  }

  /** Quads about a subject. Indexed, because every read path here starts from a subject. */
  about(subject: SubjectTerm | string): readonly Quad[] {
    const key = typeof subject === "string" ? `N:${subject}` : termKey(subject);
    return this.#bySubject.get(key) ?? this.#bySubject.get(`B:${String(subject)}`) ?? [];
  }

  match(subject?: SubjectTerm | string, predicate?: string, object?: Term): readonly Quad[] {
    const candidates = subject === undefined ? this.#quads : this.about(subject);
    return candidates.filter(
      (quad) =>
        (predicate === undefined || quad.predicate === predicate) &&
        (object === undefined || termKey(quad.object) === termKey(object)),
    );
  }

  objects(subject: SubjectTerm | string, predicate: string): readonly Term[] {
    return this.match(subject, predicate).map((quad) => quad.object);
  }

  object(subject: SubjectTerm | string, predicate: string): Term | undefined {
    return this.objects(subject, predicate)[0];
  }

  /** Literal lexical value, or `undefined` when absent or not a literal. */
  literal(subject: SubjectTerm | string, predicate: string): string | undefined {
    const term = this.object(subject, predicate);
    return term?.termType === "Literal" ? term.value : undefined;
  }

  iri(subject: SubjectTerm | string, predicate: string): string | undefined {
    const term = this.object(subject, predicate);
    return term?.termType === "NamedNode" ? term.value : undefined;
  }

  types(subject: SubjectTerm | string): readonly string[] {
    return this.objects(subject, `${NS.rdf}type`)
      .filter((term): term is NamedNode => term.termType === "NamedNode")
      .map((term) => term.value);
  }

  /** Every subject asserted to be of `typeIri`. */
  subjectsOfType(typeIri: string): readonly SubjectTerm[] {
    return this.#quads
      .filter((quad) => quad.predicate === `${NS.rdf}type` && quad.object.termType === "NamedNode" && quad.object.value === typeIri)
      .map((quad) => quad.subject);
  }

  subjects(): readonly SubjectTerm[] {
    const seen = new Map<string, SubjectTerm>();
    for (const quad of this.#quads) seen.set(termKey(quad.subject), quad.subject);
    return [...seen.values()];
  }
}

// ---------------------------------------------------------------------------------------------
// RDF/XML parsing
// ---------------------------------------------------------------------------------------------

export class RdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RdfError";
  }
}

const RDF_ABOUT = `${NS.rdf}about`;
const RDF_RESOURCE = `${NS.rdf}resource`;
const RDF_ID = `${NS.rdf}ID`;
const RDF_NODE_ID = `${NS.rdf}nodeID`;
const RDF_DATATYPE = `${NS.rdf}datatype`;
const RDF_TYPE = `${NS.rdf}type`;
const RDF_PARSE_TYPE = `${NS.rdf}parseType`;
const XML_LANG = "http://www.w3.org/XML/1998/namespacelang";

export interface ParseOptions {
  /** Base IRI for resolving relative references such as `rdf:about="doc1"`. */
  readonly base?: string;
}

/** Resolves a possibly-relative reference against a base IRI. */
export function resolveIri(reference: string, base: string | undefined): string {
  if (reference === "") return base ?? "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(reference)) return reference;
  if (!base) return reference;
  if (reference.startsWith("#")) {
    const hashIndex = base.indexOf("#");
    return (hashIndex === -1 ? base : base.slice(0, hashIndex)) + reference;
  }
  const separator = base.endsWith("/") || base.endsWith("#") ? "" : "/";
  return `${base}${separator}${reference}`;
}

export function parseRdfXml(source: string, options: ParseOptions = {}): Graph {
  const root = parseXml(source);
  if (root.namespace !== NS.rdf || root.localName !== "RDF") {
    throw new RdfError(`Expected an rdf:RDF root element, found "${root.qualifiedName}".`);
  }
  const graph = new Graph();
  const base = root.attributes.get("http://www.w3.org/XML/1998/namespacebase") ?? options.base;
  let blankCounter = 0;
  const nextBlank = (): BlankNode => blankNode(`b${++blankCounter}`);

  const subjectOf = (element: XmlElement): SubjectTerm => {
    const about = element.attributes.get(RDF_ABOUT);
    if (about !== undefined) return namedNode(resolveIri(about, base));
    const id = element.attributes.get(RDF_ID);
    if (id !== undefined) return namedNode(resolveIri(`#${id}`, base));
    const nodeId = element.attributes.get(RDF_NODE_ID);
    if (nodeId !== undefined) return blankNode(nodeId);
    return nextBlank();
  };

  const readNode = (element: XmlElement): SubjectTerm => {
    const subject = subjectOf(element);

    // A typed node element asserts its own type; rdf:Description is the untyped form.
    if (!(element.namespace === NS.rdf && element.localName === "Description")) {
      if (element.namespace === undefined) {
        throw new RdfError(`Node element "${element.qualifiedName}" is not in a namespace.`);
      }
      graph.add(subject, RDF_TYPE, namedNode(`${element.namespace}${element.localName}`));
    }

    // Property attributes: any non-RDF attribute on a node element is a literal property.
    for (const [name, value] of element.attributes) {
      if (name.startsWith(NS.rdf) || !name.includes("://")) continue;
      graph.add(subject, name, literal(value));
    }

    for (const child of element.children) readProperty(subject, child);
    return subject;
  };

  const readProperty = (subject: SubjectTerm, element: XmlElement): void => {
    if (element.namespace === undefined) {
      throw new RdfError(`Property element "${element.qualifiedName}" is not in a namespace.`);
    }
    const predicate = `${element.namespace}${element.localName}`;

    const parseType = element.attributes.get(RDF_PARSE_TYPE);
    if (parseType !== undefined) {
      // Silently dropping these would lose data; representing them wrongly is worse.
      throw new RdfError(`rdf:parseType="${parseType}" is not supported.`);
    }

    const resource = element.attributes.get(RDF_RESOURCE);
    if (resource !== undefined) {
      graph.add(subject, predicate, namedNode(resolveIri(resource, base)));
      return;
    }
    const nodeId = element.attributes.get(RDF_NODE_ID);
    if (nodeId !== undefined) {
      graph.add(subject, predicate, blankNode(nodeId));
      return;
    }

    const nodeChildren = element.children;
    if (nodeChildren.length > 0) {
      for (const child of nodeChildren) {
        graph.add(subject, predicate, readNode(child));
      }
      return;
    }

    const datatype = element.attributes.get(RDF_DATATYPE);
    const language = element.attributes.get(XML_LANG) ?? element.attributes.get("lang");
    graph.add(
      subject,
      predicate,
      literal(element.text, {
        ...(datatype === undefined ? {} : { datatype }),
        ...(language === undefined ? {} : { language }),
      }),
    );
  };

  for (const child of root.children) readNode(child);
  return graph;
}

// ---------------------------------------------------------------------------------------------
// RDF/XML serialisation
// ---------------------------------------------------------------------------------------------

export interface SerializeOptions {
  readonly prefixes?: Readonly<Record<string, string>>;
  readonly base?: string;
}

function splitIri(iri: string): { namespace: string; local: string } | undefined {
  const hash = iri.lastIndexOf("#");
  if (hash !== -1) return { namespace: iri.slice(0, hash + 1), local: iri.slice(hash + 1) };
  const slash = iri.lastIndexOf("/");
  if (slash !== -1 && slash < iri.length - 1) {
    return { namespace: iri.slice(0, slash + 1), local: iri.slice(slash + 1) };
  }
  return undefined;
}

export function serializeRdfXml(graph: Graph, options: SerializeOptions = {}): string {
  // `rdf` is seeded unconditionally: the writer emits rdf:RDF, rdf:about, rdf:resource, rdf:nodeID
  // and rdf:datatype regardless of the graph's content, so leaving it to the caller produces a
  // document that references an undeclared prefix and will not parse.
  const prefixes: Record<string, string> = { rdf: NS.rdf, ...(options.prefixes ?? {}) };
  const byNamespace = new Map<string, string>();
  for (const [prefix, iri] of Object.entries(prefixes)) byNamespace.set(iri, prefix);

  let generated = 0;
  const qualify = (iri: string): string => {
    const split = splitIri(iri);
    if (!split) throw new RdfError(`Cannot form a qualified name for "${iri}".`);
    let prefix = byNamespace.get(split.namespace);
    if (prefix === undefined) {
      prefix = `ns${++generated}`;
      byNamespace.set(split.namespace, prefix);
      prefixes[prefix] = split.namespace;
    }
    return `${prefix}:${split.local}`;
  };

  // Grouped by subject so each becomes one node element, which is what makes the output readable
  // and what consumers of ICDD index files expect to see.
  const grouped = new Map<string, { subject: SubjectTerm; quads: Quad[] }>();
  for (const quad of graph.quads) {
    const key = termKey(quad.subject);
    const bucket = grouped.get(key);
    if (bucket) bucket.quads.push(quad);
    else grouped.set(key, { subject: quad.subject, quads: [quad] });
  }

  const children: XmlNodeInput[] = [];
  for (const { subject, quads } of grouped.values()) {
    const typeQuads = quads.filter(
      (quad) => quad.predicate === RDF_TYPE && quad.object.termType === "NamedNode",
    );
    const primaryType = typeQuads[0]?.object;
    const nodeName =
      primaryType && primaryType.termType === "NamedNode"
        ? qualify(primaryType.value)
        : "rdf:Description";

    const attributes: Record<string, string | undefined> =
      subject.termType === "NamedNode"
        ? { "rdf:about": subject.value }
        : { "rdf:nodeID": subject.value };

    const propertyNodes: XmlNodeInput[] = [];
    for (const quad of quads) {
      // The first rdf:type became the element name; any further ones stay as explicit properties.
      if (quad === typeQuads[0]) continue;

      const name = qualify(quad.predicate);
      if (quad.object.termType === "NamedNode") {
        propertyNodes.push({ name, attributes: { "rdf:resource": quad.object.value } });
      } else if (quad.object.termType === "BlankNode") {
        propertyNodes.push({ name, attributes: { "rdf:nodeID": quad.object.value } });
      } else {
        propertyNodes.push({
          name,
          attributes: {
            ...(quad.object.datatype === undefined ? {} : { "rdf:datatype": quad.object.datatype }),
            ...(quad.object.language === undefined ? {} : { "xml:lang": quad.object.language }),
          },
          text: quad.object.value,
        });
      }
    }

    children.push({ name: nodeName, attributes, children: propertyNodes });
  }

  return writeXml(
    {
      name: "rdf:RDF",
      ...(options.base === undefined ? {} : { attributes: { "xml:base": options.base } }),
      children,
    },
    { prefixes },
  );
}
