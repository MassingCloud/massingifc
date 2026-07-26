import { normalisePath, type ContainerArchive } from "./archive.js";
import { CONTAINER_LAYOUT, LINK_TYPES, linkTypeByIri } from "./ontology.js";
import { readContainer, type ReadContainerResult } from "./container.js";

/**
 * Structural conformance checking for ISO 21597 containers.
 *
 * Deliberately structural rather than SHACL-based. A full SHACL engine would be a large dependency
 * for a check whose failures are almost always mundane — a payload file that did not get written,
 * a link pointing at a document that was renamed. Those are caught here, cheaply, with a message
 * that says which file. Hosts needing full ontology-level validation can run the published SHACL
 * shapes over `indexGraph` and `linksetGraphs`, which this package exposes for exactly that reason.
 */

export type ValidationSeverity = "error" | "warning" | "info";

export interface ContainerValidationIssue {
  readonly severity: ValidationSeverity;
  readonly code:
    | "missing-index"
    | "index-unparseable"
    | "no-container-description"
    | "multiple-container-descriptions"
    | "missing-conformance-indicator"
    | "document-missing-filename"
    | "payload-file-missing"
    | "undeclared-payload-file"
    | "linkset-missing-filename"
    | "linkset-file-missing"
    | "link-references-unknown-document"
    | "link-has-no-elements"
    | "directed-link-missing-endpoint"
    | "non-directed-link-has-endpoints"
    | "unknown-link-type"
    | "external-document-missing-url";
  readonly message: string;
  readonly subject?: string;
}

export interface ContainerValidationReport {
  readonly conformant: boolean;
  readonly issues: readonly ContainerValidationIssue[];
  readonly errors: number;
  readonly warnings: number;
  readonly container?: ReadContainerResult;
}

export async function validateContainer(
  archive: ContainerArchive,
): Promise<ContainerValidationReport> {
  const issues: ContainerValidationIssue[] = [];
  const entries = new Set((await archive.entries()).map(normalisePath));

  if (!entries.has(CONTAINER_LAYOUT.index)) {
    return report([
      {
        severity: "error",
        code: "missing-index",
        message: `Container has no "${CONTAINER_LAYOUT.index}" at its root.`,
      },
    ]);
  }

  let container: ReadContainerResult;
  try {
    container = await readContainer(archive);
  } catch (thrown) {
    return report([
      {
        severity: "error",
        code: "index-unparseable",
        message: thrown instanceof Error ? thrown.message : String(thrown),
      },
    ]);
  }

  const descriptions = container.indexGraph.subjectsOfType(
    "https://standards.iso.org/iso/21597/-1/ed-1/en/Container#ContainerDescription",
  );
  if (descriptions.length > 1) {
    issues.push({
      severity: "error",
      code: "multiple-container-descriptions",
      message: `Index declares ${descriptions.length} container descriptions; exactly one is allowed.`,
    });
  }
  if (!container.description.conformanceIndicator) {
    issues.push({
      severity: "warning",
      code: "missing-conformance-indicator",
      message: "Container description has no ct:conformanceIndicator.",
      subject: container.description.id,
    });
  }

  const declaredPayloadPaths = new Set<string>();
  const documentIds = new Set(container.documents.map((document) => document.id));

  for (const document of container.documents) {
    if (document.kind === "internal") {
      if (!document.filename) {
        issues.push({
          severity: "error",
          code: "document-missing-filename",
          message: `Internal document "${document.id}" declares no ct:filename.`,
          subject: document.id,
        });
        continue;
      }
      const path = normalisePath(`${CONTAINER_LAYOUT.payloadFolder}/${document.filename}`);
      declaredPayloadPaths.add(path);
      if (!entries.has(path)) {
        issues.push({
          severity: "error",
          code: "payload-file-missing",
          message: `Document "${document.id}" declares "${document.filename}" but the file is not in the container.`,
          subject: document.id,
        });
      }
    } else if (document.kind === "external" && !document.url) {
      issues.push({
        severity: "error",
        code: "external-document-missing-url",
        message: `External document "${document.id}" declares no ct:url.`,
        subject: document.id,
      });
    }
  }

  // A file present but undeclared is not an error — the standard does not forbid it — but it will
  // be invisible to any consumer reading the index, which is nearly always a packaging mistake.
  const payloadPrefix = `${CONTAINER_LAYOUT.payloadFolder}/`;
  for (const entry of entries) {
    if (!entry.startsWith(payloadPrefix)) continue;
    if (entry.endsWith("/")) continue;
    if (!declaredPayloadPaths.has(entry)) {
      issues.push({
        severity: "warning",
        code: "undeclared-payload-file",
        message: `"${entry}" is in the payload folder but is not declared in the index.`,
        subject: entry,
      });
    }
  }

  for (const linkset of container.linksets) {
    if (!linkset.filename) {
      issues.push({
        severity: "error",
        code: "linkset-missing-filename",
        message: `Linkset "${linkset.id}" declares no ct:filename.`,
        subject: linkset.id,
      });
      continue;
    }
    const path = normalisePath(`${CONTAINER_LAYOUT.triplesFolder}/${linkset.filename}`);
    if (!entries.has(path)) {
      issues.push({
        severity: "error",
        code: "linkset-file-missing",
        message: `Linkset "${linkset.id}" declares "${linkset.filename}" but the file is not in the container.`,
        subject: linkset.id,
      });
      continue;
    }

    for (const link of linkset.links) {
      if (link.elements.length === 0) {
        issues.push({
          severity: "error",
          code: "link-has-no-elements",
          message: `Link "${link.id}" has no link elements.`,
          subject: link.id,
        });
        continue;
      }

      const descriptor = linkTypeByIri(link.typeIri);
      if (link.type === undefined) {
        issues.push({
          severity: "warning",
          code: "unknown-link-type",
          message: `Link "${link.id}" uses an unrecognised type <${link.typeIri}>.`,
          subject: link.id,
        });
      }

      if (descriptor?.directed) {
        const hasFrom = link.elements.some((element) => element.role === "from");
        const hasTo = link.elements.some((element) => element.role === "to");
        if (!hasFrom || !hasTo) {
          issues.push({
            severity: "error",
            code: "directed-link-missing-endpoint",
            message: `Directed link "${link.id}" (${descriptor.name}) needs both a from and a to element.`,
            subject: link.id,
          });
        }
      } else if (descriptor && !descriptor.directed) {
        const directional = link.elements.filter((element) => element.role !== "element");
        if (directional.length > 0) {
          // e.g. IsIdenticalTo is symmetric; a from/to pair implies a direction it does not have.
          issues.push({
            severity: "warning",
            code: "non-directed-link-has-endpoints",
            message: `Link "${link.id}" (${descriptor.name}) is symmetric but uses directed endpoints.`,
            subject: link.id,
          });
        }
      }

      for (const element of link.elements) {
        if (!element.documentId || !documentIds.has(element.documentId)) {
          issues.push({
            severity: "error",
            code: "link-references-unknown-document",
            message: `Link "${link.id}" references document "${element.documentId || "(none)"}", which the index does not declare.`,
            subject: link.id,
          });
        }
      }
    }
  }

  return report(issues, container);
}

function report(
  issues: readonly ContainerValidationIssue[],
  container?: ReadContainerResult,
): ContainerValidationReport {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  return {
    conformant: errors === 0,
    issues,
    errors,
    warnings,
    ...(container === undefined ? {} : { container }),
  };
}

/** The nine ISO 21597-2 semantic families, for UI grouping and reporting. */
export function linkTypeFamilies(): readonly string[] {
  return [...new Set(Object.values(LINK_TYPES).map((descriptor) => descriptor.family))];
}
