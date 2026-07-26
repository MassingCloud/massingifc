/**
 * `@massingifc/icdd` — ISO 21597 Information Container for linked Document Delivery.
 *
 * Implements the container ontology (Part 1), the base linkset, and all nine Part 2 link types,
 * with RDF/XML read and write, container assembly and structural validation.
 *
 * Two deliberate boundaries:
 *  - **ZIP is a port.** `ContainerArchive` abstracts entry access so the package stays portable and
 *    dependency-free; the host supplies compression.
 *  - **Element-level links are first class.** A link can address a wall inside an IFC model or a
 *    clause inside a specification, which is the capability that makes ICDD worth more than a zip
 *    file with a manifest.
 */

export {
  CONTAINER_LAYOUT,
  CT,
  DEFAULT_PREFIXES,
  ELS,
  LINK_TYPES,
  LS,
  linkTypeByIri,
  NS,
  ONTOLOGY_IRI,
  type ExtendedLinkType,
  type LinkTypeDescriptor,
} from "./ontology.js";

export {
  decodeEntities,
  escapeAttribute,
  escapeText,
  findElement,
  parseXml,
  writeXml,
  XmlError,
  type XmlElement,
  type XmlNodeInput,
  type XmlWriterOptions,
} from "./xml.js";

export {
  blankNode,
  Graph,
  literal,
  namedNode,
  parseRdfXml,
  RdfError,
  resolveIri,
  serializeRdfXml,
  type BlankNode,
  type Literal,
  type NamedNode,
  type ParseOptions,
  type Quad,
  type SerializeOptions,
  type SubjectTerm,
  type Term,
} from "./rdf.js";

export {
  decodeTextBytes,
  encodeText,
  MemoryArchive,
  normalisePath,
  readArchiveText,
  writeArchiveText,
  type ContainerArchive,
} from "./archive.js";

export {
  buildIndexGraph,
  buildLinksetGraph,
  payloadPath,
  readContainer,
  writeContainer,
  type ContainerDescription,
  type ContainerDocument,
  type ContainerIriOptions,
  type ContainerParty,
  type ExternalDocument,
  type FolderDocument,
  type IcddContainer,
  type InternalDocument,
  type LinkClass,
  type LinkElementSpec,
  type LinkIdentifier,
  type LinksetSpec,
  type LinkSpec,
  type PartyKind,
  type ReadContainerResult,
  type ReadLink,
  type ReadLinkElement,
  type ReadLinkset,
  type WriteContainerOptions,
} from "./container.js";

export {
  linkTypeFamilies,
  validateContainer,
  type ContainerValidationIssue,
  type ContainerValidationReport,
  type ValidationSeverity,
} from "./validation.js";

export {
  createIcddPlugin,
  icddPlugin,
  IcddToken,
  ICDD_COMMANDS,
  type IcddPluginOptions,
  type IcddService,
} from "./plugin.js";
