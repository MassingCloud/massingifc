import {
  CONTAINER_LAYOUT,
  CT,
  DEFAULT_PREFIXES,
  ELS,
  LINK_TYPES,
  LS,
  NS,
  ONTOLOGY_IRI,
  linkTypeByIri,
  type ExtendedLinkType,
} from "./ontology.js";
import {
  Graph,
  literal,
  namedNode,
  parseRdfXml,
  serializeRdfXml,
  type SubjectTerm,
} from "./rdf.js";
import {
  normalisePath,
  readArchiveText,
  writeArchiveText,
  type ContainerArchive,
} from "./archive.js";

/**
 * A typed view of an ISO 21597 container.
 *
 * The RDF is the authoritative wire format, but nothing above this module should have to think in
 * triples to add a document or draw a link. These records are the ergonomic layer; `buildContainer`
 * and `readContainer` are the only places that know the vocabulary.
 */

export type PartyKind = "Person" | "Organisation";

export interface ContainerParty {
  readonly id: string;
  readonly kind: PartyKind;
  readonly name: string;
  readonly description?: string;
  readonly userID?: string;
}

interface DocumentCommon {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly creationDate?: string;
  readonly modificationDate?: string;
  readonly versionID?: string;
  readonly versionDescription?: string;
  readonly createdBy?: string;
  readonly format?: string;
}

/** A document physically carried inside `Payload documents/`. */
export interface InternalDocument extends DocumentCommon {
  readonly kind: "internal";
  /** Path relative to the payload folder. */
  readonly filename: string;
  readonly filetype?: string;
  readonly checksum?: string;
  readonly checksumAlgorithm?: string;
}

/** A document referenced by URL rather than carried. */
export interface ExternalDocument extends DocumentCommon {
  readonly kind: "external";
  readonly url: string;
}

export interface FolderDocument extends DocumentCommon {
  readonly kind: "folder";
  readonly foldername: string;
  /** Ids of the documents this folder contains. */
  readonly contains: readonly string[];
}

export type ContainerDocument = InternalDocument | ExternalDocument | FolderDocument;

export interface ContainerDescription {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly conformanceIndicator?: string;
  readonly creationDate?: string;
  readonly createdBy?: string;
  readonly versionID?: string;
  readonly versionDescription?: string;
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/**
 * How a link element points inside a document.
 *
 * This is the capability that distinguishes ICDD from a zip file with a manifest: a link can
 * address a single wall inside an IFC model, a cell range in a spreadsheet, or a clause in a
 * specification, not merely the file as a whole.
 */
export type LinkIdentifier =
  | { readonly kind: "string"; readonly value: string; readonly field?: string }
  | { readonly kind: "uri"; readonly uri: string }
  | { readonly kind: "query"; readonly language: string; readonly expression: string };

export interface LinkElementSpec {
  readonly documentId: string;
  readonly identifier?: LinkIdentifier;
}

export type LinkClass =
  | "Link"
  | "BinaryLink"
  | "DirectedLink"
  | "DirectedBinaryLink"
  | "Directed1toNLink"
  | ExtendedLinkType;

export interface LinkSpec {
  readonly id?: string;
  readonly type: LinkClass;
  /** Non-directional participants. */
  readonly elements?: readonly LinkElementSpec[];
  /** Directional source(s). */
  readonly from?: readonly LinkElementSpec[];
  /** Directional target(s). */
  readonly to?: readonly LinkElementSpec[];
}

export interface LinksetSpec {
  readonly id: string;
  readonly name: string;
  /** File name inside `Payload triples/`. */
  readonly filename: string;
  readonly links: readonly LinkSpec[];
}

export interface IcddContainer {
  readonly description: ContainerDescription;
  readonly documents: readonly ContainerDocument[];
  readonly linksets: readonly LinksetSpec[];
  readonly parties: readonly ContainerParty[];
}

export interface ContainerIriOptions {
  /**
   * Base IRI for subjects in the index. Defaults to a URN derived from the container id.
   *
   * A URN rather than an http IRI by default: container subjects are internal identity, and
   * minting http IRIs that do not resolve is a small dishonesty that causes real confusion when
   * someone later tries to dereference one.
   */
  readonly baseIri?: string;
}

const defaultBase = (containerId: string): string => `urn:icdd:${containerId}#`;

const isExtendedLinkType = (type: LinkClass): type is ExtendedLinkType => type in LINK_TYPES;

function linkClassIri(type: LinkClass): string {
  if (isExtendedLinkType(type)) return ELS[type];
  return LS[type];
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

function addOptionalLiteral(
  graph: Graph,
  subject: SubjectTerm,
  predicate: string,
  value: string | undefined,
): void {
  if (value !== undefined && value !== "") graph.add(subject, predicate, literal(value));
}

/** Serialises the container index (`index.rdf`). */
export function buildIndexGraph(container: IcddContainer, options: ContainerIriOptions = {}): Graph {
  const base = options.baseIri ?? defaultBase(container.description.id);
  const iri = (id: string): SubjectTerm => namedNode(`${base}${id}`);
  const graph = new Graph();

  const description = iri(container.description.id);
  graph.add(description, `${NS.rdf}type`, namedNode(CT.ContainerDescription));
  graph.add(description, `${NS.owl}imports`, namedNode(ONTOLOGY_IRI.container));
  addOptionalLiteral(graph, description, CT.name, container.description.name);
  addOptionalLiteral(graph, description, CT.description, container.description.description);
  addOptionalLiteral(
    graph,
    description,
    CT.conformanceIndicator,
    container.description.conformanceIndicator,
  );
  addOptionalLiteral(graph, description, CT.creationDate, container.description.creationDate);
  addOptionalLiteral(graph, description, CT.versionID, container.description.versionID);
  addOptionalLiteral(
    graph,
    description,
    CT.versionDescription,
    container.description.versionDescription,
  );
  if (container.description.createdBy) {
    graph.add(description, CT.createdBy, iri(container.description.createdBy));
  }

  for (const party of container.parties) {
    const subject = iri(party.id);
    graph.add(subject, `${NS.rdf}type`, namedNode(party.kind === "Person" ? CT.Person : CT.Organisation));
    addOptionalLiteral(graph, subject, CT.name, party.name);
    addOptionalLiteral(graph, subject, CT.description, party.description);
    addOptionalLiteral(graph, subject, CT.userID, party.userID);
  }

  for (const document of container.documents) {
    const subject = iri(document.id);
    const typeIri =
      document.kind === "internal"
        ? CT.InternalDocument
        : document.kind === "external"
          ? CT.ExternalDocument
          : CT.FolderDocument;

    graph.add(subject, `${NS.rdf}type`, namedNode(typeIri));
    graph.add(description, CT.containsDocument, subject);
    graph.add(subject, CT.belongsToContainer, description);

    addOptionalLiteral(graph, subject, CT.name, document.name);
    addOptionalLiteral(graph, subject, CT.description, document.description);
    addOptionalLiteral(graph, subject, CT.creationDate, document.creationDate);
    addOptionalLiteral(graph, subject, CT.modificationDate, document.modificationDate);
    addOptionalLiteral(graph, subject, CT.versionID, document.versionID);
    addOptionalLiteral(graph, subject, CT.versionDescription, document.versionDescription);
    addOptionalLiteral(graph, subject, CT.format, document.format);
    if (document.createdBy) graph.add(subject, CT.createdBy, iri(document.createdBy));

    if (document.kind === "internal") {
      addOptionalLiteral(graph, subject, CT.filename, document.filename);
      addOptionalLiteral(graph, subject, CT.filetype, document.filetype);
      addOptionalLiteral(graph, subject, CT.checksum, document.checksum);
      addOptionalLiteral(graph, subject, CT.checksumAlgorithm, document.checksumAlgorithm);
    } else if (document.kind === "external") {
      addOptionalLiteral(graph, subject, CT.url, document.url);
    } else {
      addOptionalLiteral(graph, subject, CT.foldername, document.foldername);
      for (const childId of document.contains) {
        graph.add(subject, CT.containsDocument, iri(childId));
      }
    }
  }

  for (const linkset of container.linksets) {
    const subject = iri(linkset.id);
    graph.add(subject, `${NS.rdf}type`, namedNode(CT.Linkset));
    graph.add(description, CT.containsLinkset, subject);
    addOptionalLiteral(graph, subject, CT.name, linkset.name);
    addOptionalLiteral(graph, subject, CT.filename, linkset.filename);
  }

  return graph;
}

/** Serialises one linkset document. */
export function buildLinksetGraph(
  linkset: LinksetSpec,
  options: ContainerIriOptions & { readonly containerId: string },
): Graph {
  const base = options.baseIri ?? defaultBase(options.containerId);
  const graph = new Graph();
  const linksetSubject = namedNode(`${base}${linkset.id}`);

  graph.add(linksetSubject, `${NS.owl}imports`, namedNode(ONTOLOGY_IRI.linkset));
  const usesExtended = linkset.links.some((link) => isExtendedLinkType(link.type));
  if (usesExtended) {
    // Part 2 classes are only meaningful if the document declares the ontology they come from.
    graph.add(linksetSubject, `${NS.owl}imports`, namedNode(ONTOLOGY_IRI.extendedLinkset));
  }

  let counter = 0;
  const elementSubject = (): SubjectTerm => namedNode(`${base}le-${++counter}`);

  const writeElement = (spec: LinkElementSpec): SubjectTerm => {
    const subject = elementSubject();
    graph.add(subject, `${NS.rdf}type`, namedNode(LS.LinkElement));
    graph.add(subject, LS.hasDocument, namedNode(`${base}${spec.documentId}`));

    if (spec.identifier) {
      const identifier = namedNode(`${subject.value}-id`);
      graph.add(subject, LS.hasIdentifier, identifier);
      if (spec.identifier.kind === "string") {
        graph.add(identifier, `${NS.rdf}type`, namedNode(LS.StringBasedIdentifier));
        graph.add(identifier, LS.identifier, literal(spec.identifier.value));
        addOptionalLiteral(graph, identifier, LS.identifierField, spec.identifier.field);
      } else if (spec.identifier.kind === "uri") {
        graph.add(identifier, `${NS.rdf}type`, namedNode(LS.URIBasedIdentifier));
        graph.add(identifier, LS.uri, literal(spec.identifier.uri, { datatype: `${NS.xsd}anyURI` }));
      } else {
        graph.add(identifier, `${NS.rdf}type`, namedNode(LS.QueryBasedIdentifier));
        graph.add(identifier, LS.queryLanguage, literal(spec.identifier.language));
        graph.add(identifier, LS.queryExpression, literal(spec.identifier.expression));
      }
    }
    return subject;
  };

  linkset.links.forEach((link, index) => {
    const subject = namedNode(`${base}${link.id ?? `link-${index + 1}`}`);
    graph.add(subject, `${NS.rdf}type`, namedNode(linkClassIri(link.type)));

    for (const element of link.elements ?? []) {
      graph.add(subject, LS.hasLinkElement, writeElement(element));
    }
    for (const element of link.from ?? []) {
      graph.add(subject, LS.hasFromLinkElement, writeElement(element));
    }
    for (const element of link.to ?? []) {
      graph.add(subject, LS.hasToLinkElement, writeElement(element));
    }
  });

  return graph;
}

export interface WriteContainerOptions extends ContainerIriOptions {
  /** Extra ontology documents to place in `Ontology resources/`, keyed by file name. */
  readonly ontologyResources?: Readonly<Record<string, string>>;
}

/**
 * Writes the RDF side of a container into an archive.
 *
 * Payload files themselves are written by the caller — this function has no way to obtain their
 * bytes and should not pretend to. `validateContainer` is what confirms the two halves agree.
 */
export async function writeContainer(
  archive: ContainerArchive,
  container: IcddContainer,
  options: WriteContainerOptions = {},
): Promise<void> {
  const index = buildIndexGraph(container, options);
  await writeArchiveText(
    archive,
    CONTAINER_LAYOUT.index,
    serializeRdfXml(index, { prefixes: DEFAULT_PREFIXES }),
  );

  for (const linkset of container.linksets) {
    const graph = buildLinksetGraph(linkset, {
      containerId: container.description.id,
      ...(options.baseIri === undefined ? {} : { baseIri: options.baseIri }),
    });
    await writeArchiveText(
      archive,
      `${CONTAINER_LAYOUT.triplesFolder}/${linkset.filename}`,
      serializeRdfXml(graph, { prefixes: DEFAULT_PREFIXES }),
    );
  }

  for (const [filename, content] of Object.entries(options.ontologyResources ?? {})) {
    await writeArchiveText(archive, `${CONTAINER_LAYOUT.ontologyFolder}/${filename}`, content);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const localId = (iriValue: string): string => {
  const hash = iriValue.lastIndexOf("#");
  if (hash !== -1) return iriValue.slice(hash + 1);
  const slash = iriValue.lastIndexOf("/");
  return slash === -1 ? iriValue : iriValue.slice(slash + 1);
};

function readDocuments(graph: Graph): ContainerDocument[] {
  const documents: ContainerDocument[] = [];

  const common = (subject: SubjectTerm): DocumentCommon => ({
    id: localId(subject.value),
    name: graph.literal(subject, CT.name) ?? localId(subject.value),
    ...opt("description", graph.literal(subject, CT.description)),
    ...opt("creationDate", graph.literal(subject, CT.creationDate)),
    ...opt("modificationDate", graph.literal(subject, CT.modificationDate)),
    ...opt("versionID", graph.literal(subject, CT.versionID)),
    ...opt("versionDescription", graph.literal(subject, CT.versionDescription)),
    ...opt("format", graph.literal(subject, CT.format)),
    ...opt("createdBy", graph.iri(subject, CT.createdBy)),
  });

  for (const subject of graph.subjectsOfType(CT.InternalDocument)) {
    documents.push({
      ...common(subject),
      kind: "internal",
      filename: graph.literal(subject, CT.filename) ?? "",
      ...opt("filetype", graph.literal(subject, CT.filetype)),
      ...opt("checksum", graph.literal(subject, CT.checksum)),
      ...opt("checksumAlgorithm", graph.literal(subject, CT.checksumAlgorithm)),
    });
  }
  for (const subject of graph.subjectsOfType(CT.ExternalDocument)) {
    documents.push({ ...common(subject), kind: "external", url: graph.literal(subject, CT.url) ?? "" });
  }
  for (const subject of graph.subjectsOfType(CT.FolderDocument)) {
    documents.push({
      ...common(subject),
      kind: "folder",
      foldername: graph.literal(subject, CT.foldername) ?? "",
      contains: graph
        .objects(subject, CT.containsDocument)
        .filter((term) => term.termType === "NamedNode")
        .map((term) => localId(term.value)),
    });
  }
  return documents;
}

/** Omits the key entirely when the value is absent, which `exactOptionalPropertyTypes` requires. */
function opt<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

export interface ReadLinkElement {
  readonly documentId: string;
  readonly identifier?: LinkIdentifier;
  readonly role: "element" | "from" | "to";
}

export interface ReadLink {
  readonly id: string;
  readonly typeIri: string;
  readonly type: LinkClass | undefined;
  readonly elements: readonly ReadLinkElement[];
}

export interface ReadLinkset {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
  readonly links: readonly ReadLink[];
}

export interface ReadContainerResult {
  readonly description: ContainerDescription;
  readonly documents: readonly ContainerDocument[];
  readonly parties: readonly ContainerParty[];
  readonly linksets: readonly ReadLinkset[];
  readonly indexGraph: Graph;
  readonly linksetGraphs: ReadonlyMap<string, Graph>;
}

function readLinkElements(graph: Graph, linkSubject: SubjectTerm): ReadLinkElement[] {
  const roles: readonly [string, ReadLinkElement["role"]][] = [
    [LS.hasLinkElement, "element"],
    [LS.hasFromLinkElement, "from"],
    [LS.hasToLinkElement, "to"],
  ];

  const elements: ReadLinkElement[] = [];
  for (const [predicate, role] of roles) {
    for (const term of graph.objects(linkSubject, predicate)) {
      if (term.termType === "Literal") continue;
      const documentIri = graph.iri(term, LS.hasDocument);
      const identifierTerm = graph.object(term, LS.hasIdentifier);

      let identifier: LinkIdentifier | undefined;
      if (identifierTerm && identifierTerm.termType !== "Literal") {
        const types = graph.types(identifierTerm);
        if (types.includes(LS.StringBasedIdentifier)) {
          const value = graph.literal(identifierTerm, LS.identifier);
          const field = graph.literal(identifierTerm, LS.identifierField);
          if (value !== undefined) {
            identifier = { kind: "string", value, ...(field === undefined ? {} : { field }) };
          }
        } else if (types.includes(LS.URIBasedIdentifier)) {
          const uri = graph.literal(identifierTerm, LS.uri);
          if (uri !== undefined) identifier = { kind: "uri", uri };
        } else if (types.includes(LS.QueryBasedIdentifier)) {
          const language = graph.literal(identifierTerm, LS.queryLanguage);
          const expression = graph.literal(identifierTerm, LS.queryExpression);
          if (language !== undefined && expression !== undefined) {
            identifier = { kind: "query", language, expression };
          }
        }
      }

      elements.push({
        documentId: documentIri === undefined ? "" : localId(documentIri),
        role,
        ...(identifier === undefined ? {} : { identifier }),
      });
    }
  }
  return elements;
}

export async function readContainer(archive: ContainerArchive): Promise<ReadContainerResult> {
  const indexText = await readArchiveText(archive, CONTAINER_LAYOUT.index);
  if (indexText === undefined) {
    throw new Error(`Container has no "${CONTAINER_LAYOUT.index}".`);
  }
  const indexGraph = parseRdfXml(indexText);

  const descriptionSubject = indexGraph.subjectsOfType(CT.ContainerDescription)[0];
  if (!descriptionSubject) {
    throw new Error("Container index declares no ct:ContainerDescription.");
  }

  const description: ContainerDescription = {
    id: localId(descriptionSubject.value),
    name: indexGraph.literal(descriptionSubject, CT.name) ?? "",
    ...opt("description", indexGraph.literal(descriptionSubject, CT.description)),
    ...opt("conformanceIndicator", indexGraph.literal(descriptionSubject, CT.conformanceIndicator)),
    ...opt("creationDate", indexGraph.literal(descriptionSubject, CT.creationDate)),
    ...opt("versionID", indexGraph.literal(descriptionSubject, CT.versionID)),
    ...opt("versionDescription", indexGraph.literal(descriptionSubject, CT.versionDescription)),
  };

  const parties: ContainerParty[] = [];
  for (const [typeIri, kind] of [
    [CT.Person, "Person"],
    [CT.Organisation, "Organisation"],
  ] as const) {
    for (const subject of indexGraph.subjectsOfType(typeIri)) {
      parties.push({
        id: localId(subject.value),
        kind,
        name: indexGraph.literal(subject, CT.name) ?? "",
        ...opt("description", indexGraph.literal(subject, CT.description)),
        ...opt("userID", indexGraph.literal(subject, CT.userID)),
      });
    }
  }

  const linksets: ReadLinkset[] = [];
  const linksetGraphs = new Map<string, Graph>();

  for (const subject of indexGraph.subjectsOfType(CT.Linkset)) {
    const filename = indexGraph.literal(subject, CT.filename) ?? "";
    const id = localId(subject.value);
    const text = await readArchiveText(archive, `${CONTAINER_LAYOUT.triplesFolder}/${filename}`);

    let links: ReadLink[] = [];
    if (text !== undefined) {
      const graph = parseRdfXml(text);
      linksetGraphs.set(id, graph);

      const linkSubjects = new Set<SubjectTerm>();
      for (const candidate of graph.subjects()) {
        const types = graph.types(candidate);
        const isLink = types.some(
          (type) => linkTypeByIri(type) !== undefined || Object.values(LS).includes(type as never),
        );
        // Link elements and identifiers are also typed from the Linkset ontology, so a type match
        // alone is not enough — a link is what carries link elements.
        const carriesElements =
          graph.objects(candidate, LS.hasLinkElement).length > 0 ||
          graph.objects(candidate, LS.hasFromLinkElement).length > 0 ||
          graph.objects(candidate, LS.hasToLinkElement).length > 0;
        if (isLink && carriesElements) linkSubjects.add(candidate);
      }

      links = [...linkSubjects].map((linkSubject) => {
        const typeIri = graph.types(linkSubject)[0] ?? "";
        const descriptor = linkTypeByIri(typeIri);
        const baseType = Object.entries(LS).find(([, iriValue]) => iriValue === typeIri)?.[0] as
          | LinkClass
          | undefined;
        return {
          id: localId(linkSubject.value),
          typeIri,
          type: descriptor?.name ?? baseType,
          elements: readLinkElements(graph, linkSubject),
        };
      });
    }

    linksets.push({
      id,
      name: indexGraph.literal(subject, CT.name) ?? id,
      filename,
      links,
    });
  }

  return {
    description,
    documents: readDocuments(indexGraph),
    parties,
    linksets,
    indexGraph,
    linksetGraphs,
  };
}

/** Path a document's bytes live at inside the archive. */
export function payloadPath(document: InternalDocument): string {
  return normalisePath(`${CONTAINER_LAYOUT.payloadFolder}/${document.filename}`);
}
