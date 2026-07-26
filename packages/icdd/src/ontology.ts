/**
 * ISO 21597 vocabulary.
 *
 * Every IRI here was taken from the published ontology documents themselves —
 * `Container.rdf`, `Linkset.rdf` (Part 1) and `ExtendedLinkset.rdf` (Part 2) at
 * `standards.iso.org` — rather than transcribed from prose. Conformance depends on these strings
 * being exact: an ICDD container whose index declares `ct:InternalDocument` with a mistyped
 * namespace is not a container, it is a zip file that looks like one.
 */

export const NS = {
  /** ISO 21597-1 Container ontology. */
  ct: "https://standards.iso.org/iso/21597/-1/ed-1/en/Container#",
  /** ISO 21597-1 Linkset ontology. */
  ls: "https://standards.iso.org/iso/21597/-1/ed-1/en/Linkset#",
  /** ISO 21597-2 Extended Linkset ontology. */
  els: "https://standards.iso.org/iso/21597/-2/ed-1/en/ExtendedLinkset#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  dcterms: "http://purl.org/dc/terms/",
} as const;

/** Ontology document IRIs, as imported by a container's index and linksets. */
export const ONTOLOGY_IRI = {
  container: "https://standards.iso.org/iso/21597/-1/ed-1/en/Container",
  linkset: "https://standards.iso.org/iso/21597/-1/ed-1/en/Linkset",
  extendedLinkset: "https://standards.iso.org/iso/21597/-2/ed-1/en/ExtendedLinkset",
} as const;

const term =
  <T extends string>(namespace: string) =>
  (local: T): string =>
    `${namespace}${local}`;

const ct = term(NS.ct);
const ls = term(NS.ls);
const els = term(NS.els);

/** ISO 21597-1 Container ontology classes. */
export const CT = {
  ContainerDescription: ct("ContainerDescription"),
  Document: ct("Document"),
  InternalDocument: ct("InternalDocument"),
  ExternalDocument: ct("ExternalDocument"),
  FolderDocument: ct("FolderDocument"),
  SecuredDocument: ct("SecuredDocument"),
  EncryptedDocument: ct("EncryptedDocument"),
  Linkset: ct("Linkset"),
  Party: ct("Party"),
  Person: ct("Person"),
  Organisation: ct("Organisation"),

  // Object properties
  containsDocument: ct("containsDocument"),
  containsLinkset: ct("containsLinkset"),
  belongsToContainer: ct("belongsToContainer"),
  containedInContainer: ct("containedInContainer"),
  createdBy: ct("createdBy"),
  created: ct("created"),
  modifiedBy: ct("modifiedBy"),
  modified: ct("modified"),
  publishedBy: ct("publishedBy"),
  published: ct("published"),
  priorVersion: ct("priorVersion"),
  alternativeDocument: ct("alternativeDocument"),
  alternativeDocumentTo: ct("alternativeDocumentTo"),

  // Datatype properties
  name: ct("name"),
  description: ct("description"),
  filename: ct("filename"),
  foldername: ct("foldername"),
  filetype: ct("filetype"),
  format: ct("format"),
  url: ct("url"),
  versionID: ct("versionID"),
  versionDescription: ct("versionDescription"),
  creationDate: ct("creationDate"),
  modificationDate: ct("modificationDate"),
  checksum: ct("checksum"),
  checksumAlgorithm: ct("checksumAlgorithm"),
  encryptionAlgorithm: ct("encryptionAlgorithm"),
  conformanceIndicator: ct("conformanceIndicator"),
  userID: ct("userID"),
  requested: ct("requested"),
} as const;

/** ISO 21597-1 Linkset ontology classes and properties. */
export const LS = {
  Link: ls("Link"),
  BinaryLink: ls("BinaryLink"),
  DirectedLink: ls("DirectedLink"),
  DirectedBinaryLink: ls("DirectedBinaryLink"),
  Directed1toNLink: ls("Directed1toNLink"),
  LinkElement: ls("LinkElement"),
  Identifier: ls("Identifier"),
  StringBasedIdentifier: ls("StringBasedIdentifier"),
  URIBasedIdentifier: ls("URIBasedIdentifier"),
  QueryBasedIdentifier: ls("QueryBasedIdentifier"),

  hasLinkElement: ls("hasLinkElement"),
  hasFromLinkElement: ls("hasFromLinkElement"),
  hasToLinkElement: ls("hasToLinkElement"),
  hasDocument: ls("hasDocument"),
  hasIdentifier: ls("hasIdentifier"),

  identifier: ls("identifier"),
  identifierField: ls("identifierField"),
  uri: ls("uri"),
  queryLanguage: ls("queryLanguage"),
  queryExpression: ls("queryExpression"),
} as const;

/**
 * The nine ISO 21597-2 link types, as fifteen classes.
 *
 * Six of the nine are directional and appear as inverse pairs; three (identity, conflict,
 * alternative) are symmetric and have a single class each. Modelling the pairs explicitly rather
 * than as one class plus a direction flag is what the standard does, and it matters for
 * reasoning — a consumer that only understands `HasPart` should not silently read `IsPartOf`
 * backwards.
 */
export const ELS = {
  IsIdenticalTo: els("IsIdenticalTo"),
  ConflictsWith: els("ConflictsWith"),
  IsAlternativeTo: els("IsAlternativeTo"),
  Specialises: els("Specialises"),
  IsSpecialisedAs: els("IsSpecialisedAs"),
  HasPart: els("HasPart"),
  IsPartOf: els("IsPartOf"),
  HasMember: els("HasMember"),
  IsMemberOf: els("IsMemberOf"),
  Supersedes: els("Supersedes"),
  IsSupersededBy: els("IsSupersededBy"),
  Elaborates: els("Elaborates"),
  IsElaboratedBy: els("IsElaboratedBy"),
  Controls: els("Controls"),
  IsControlledBy: els("IsControlledBy"),
} as const;

export type ExtendedLinkType = keyof typeof ELS;

export interface LinkTypeDescriptor {
  readonly name: ExtendedLinkType;
  readonly iri: string;
  /** The ISO 21597-2 semantic family this class belongs to. */
  readonly family:
    | "Identity"
    | "Conflict"
    | "Alternative"
    | "Specialization"
    | "Aggregation"
    | "Membership"
    | "Replacement"
    | "Elaboration"
    | "Control";
  /** Directional links use from/to link elements; symmetric ones use plain link elements. */
  readonly directed: boolean;
  readonly inverse?: ExtendedLinkType;
}

export const LINK_TYPES: Readonly<Record<ExtendedLinkType, LinkTypeDescriptor>> = Object.freeze({
  IsIdenticalTo: { name: "IsIdenticalTo", iri: ELS.IsIdenticalTo, family: "Identity", directed: false },
  ConflictsWith: { name: "ConflictsWith", iri: ELS.ConflictsWith, family: "Conflict", directed: false },
  IsAlternativeTo: {
    name: "IsAlternativeTo",
    iri: ELS.IsAlternativeTo,
    family: "Alternative",
    directed: false,
  },
  Specialises: {
    name: "Specialises",
    iri: ELS.Specialises,
    family: "Specialization",
    directed: true,
    inverse: "IsSpecialisedAs",
  },
  IsSpecialisedAs: {
    name: "IsSpecialisedAs",
    iri: ELS.IsSpecialisedAs,
    family: "Specialization",
    directed: true,
    inverse: "Specialises",
  },
  HasPart: { name: "HasPart", iri: ELS.HasPart, family: "Aggregation", directed: true, inverse: "IsPartOf" },
  IsPartOf: { name: "IsPartOf", iri: ELS.IsPartOf, family: "Aggregation", directed: true, inverse: "HasPart" },
  HasMember: {
    name: "HasMember",
    iri: ELS.HasMember,
    family: "Membership",
    directed: true,
    inverse: "IsMemberOf",
  },
  IsMemberOf: {
    name: "IsMemberOf",
    iri: ELS.IsMemberOf,
    family: "Membership",
    directed: true,
    inverse: "HasMember",
  },
  Supersedes: {
    name: "Supersedes",
    iri: ELS.Supersedes,
    family: "Replacement",
    directed: true,
    inverse: "IsSupersededBy",
  },
  IsSupersededBy: {
    name: "IsSupersededBy",
    iri: ELS.IsSupersededBy,
    family: "Replacement",
    directed: true,
    inverse: "Supersedes",
  },
  Elaborates: {
    name: "Elaborates",
    iri: ELS.Elaborates,
    family: "Elaboration",
    directed: true,
    inverse: "IsElaboratedBy",
  },
  IsElaboratedBy: {
    name: "IsElaboratedBy",
    iri: ELS.IsElaboratedBy,
    family: "Elaboration",
    directed: true,
    inverse: "Elaborates",
  },
  Controls: { name: "Controls", iri: ELS.Controls, family: "Control", directed: true, inverse: "IsControlledBy" },
  IsControlledBy: {
    name: "IsControlledBy",
    iri: ELS.IsControlledBy,
    family: "Control",
    directed: true,
    inverse: "Controls",
  },
});

export function linkTypeByIri(iri: string): LinkTypeDescriptor | undefined {
  return Object.values(LINK_TYPES).find((descriptor) => descriptor.iri === iri);
}

/** Canonical container layout defined by ISO 21597-1. */
export const CONTAINER_LAYOUT = {
  index: "index.rdf",
  ontologyFolder: "Ontology resources",
  payloadFolder: "Payload documents",
  triplesFolder: "Payload triples",
} as const;

/** Default prefix bindings used when serialising container documents. */
export const DEFAULT_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  rdf: NS.rdf,
  rdfs: NS.rdfs,
  owl: NS.owl,
  xsd: NS.xsd,
  dcterms: NS.dcterms,
  ct: NS.ct,
  ls: NS.ls,
  els: NS.els,
});
