import {
  convertLength,
  extentIsValid,
  extentSpan,
  measurabilityReason,
  parseCrsCode,
  type TwinObjectKind,
  type TwinObjectRecord,
} from "@massingifc/project-schema";

/**
 * Checks on captured-reality datasets — scans, photogrammetry, Gaussian splats.
 *
 * Separate from alignment because they answer a different question. Alignment asks "did the fit
 * converge?"; this asks "is this dataset usable, and for what?". A splat can be perfectly aligned
 * and still be the wrong thing to measure against, and an un-georeferenced scan can look correct
 * on screen and be unreconcilable with a survey.
 */

/** Kinds that represent captured reality rather than authored or generated content. */
export const REALITY_KINDS: readonly TwinObjectKind[] = ["point-cloud", "gaussian-splat", "mesh-scan"];

export function isRealityKind(kind: TwinObjectKind): boolean {
  return REALITY_KINDS.includes(kind);
}

export type RealitySeverity = "error" | "warning" | "info";

export type RealityIssueCode =
  | "missing-georeference"
  | "unqualified-crs"
  | "invalid-extent"
  | "implausible-extent"
  | "degenerate-extent"
  | "missing-origin-offset"
  | "unverified-georeference"
  | "missing-vertical-datum"
  | "unresolved-derivative"
  | "splat-without-surface"
  | "purpose-not-measurable";

export interface RealityIssue {
  readonly severity: RealitySeverity;
  readonly code: RealityIssueCode;
  readonly message: string;
  /** The field or URI the issue is about, so a UI can point at it. */
  readonly subject?: string;
}

export interface RealityValidationReport {
  readonly valid: boolean;
  readonly issues: readonly RealityIssue[];
  readonly errors: number;
  readonly warnings: number;
}

export interface RealityValidationOptions {
  /**
   * Resolves a derivative URI, answering whether it exists.
   *
   * Injected rather than assumed because the answer depends on where the deployment stores
   * blobs — a container entry, an object store, a plain URL. Omitted means links go unchecked,
   * which is reported as unchecked rather than silently treated as fine.
   */
  readonly resolveUri?: (uri: string) => Promise<boolean>;
  /**
   * Largest plausible horizontal span, in metres. Beyond this the dataset is almost always a unit
   * or CRS mistake rather than a genuinely enormous capture.
   */
  readonly maxSpanMetres?: number;
  /** Below this a capture is effectively empty — usually a failed export. */
  readonly minSpanMetres?: number;
}

const DEFAULT_MAX_SPAN_METRES = 50_000;
const DEFAULT_MIN_SPAN_METRES = 0.05;

/**
 * Coordinate magnitude beyond which single-precision rendering visibly degrades.
 *
 * A 32-bit float carries ~7 significant decimal digits, so at 100 km from the origin the spacing
 * between representable values is already ~8 mm and geometry starts to swim and z-fight. Projected
 * national grids routinely place sites at six- or seven-digit coordinates, which is why the offset
 * matters and why its absence is worth reporting.
 */
const FLOAT_SAFE_COORDINATE_METRES = 100_000;

const DERIVATIVE_FIELDS = [
  "sourceImageryUri",
  "orthomosaicUri",
  "pointCloudUri",
  "meshUri",
  "dsmUri",
  "dtmUri",
] as const;

export async function validateRealityDataset(
  record: TwinObjectRecord,
  options: RealityValidationOptions = {},
): Promise<RealityValidationReport> {
  const issues: RealityIssue[] = [];
  const maxSpan = options.maxSpanMetres ?? DEFAULT_MAX_SPAN_METRES;
  const minSpan = options.minSpanMetres ?? DEFAULT_MIN_SPAN_METRES;
  const reality = isRealityKind(record.kind);

  const geo = record.geoReference;
  if (!geo) {
    if (reality) {
      issues.push({
        severity: "error",
        code: "missing-georeference",
        // Not a nicety: without it the dataset can never be checked against a survey, combined
        // with GIS layers, or re-registered when the project origin moves.
        message: `Reality dataset "${record.name}" has no georeference, so it cannot be reconciled with survey or GIS data.`,
        subject: "geoReference",
      });
    }
  } else {
    for (const [field, code] of [
      ["sourceCrs", geo.sourceCrs],
      ["targetCrs", geo.targetCrs],
    ] as const) {
      if (code !== undefined && !parseCrsCode(code)) {
        issues.push({
          severity: "warning",
          code: "unqualified-crs",
          message: `"${code}" is not an authority-qualified CRS code such as "EPSG:27700".`,
          subject: field,
        });
      }
    }

    if (geo.method === "assumed" || geo.method === undefined) {
      issues.push({
        severity: "warning",
        code: "unverified-georeference",
        message: `Georeference for "${record.name}" is ${geo.method === undefined ? "of unrecorded provenance" : "assumed"} — nothing has verified it against control.`,
        subject: "geoReference.method",
      });
    }

    if (geo.verticalDatum === undefined) {
      issues.push({
        severity: "warning",
        code: "missing-vertical-datum",
        // Two datasets can agree exactly in plan and sit a metre apart in height. That gap is the
        // difference between a slab that clashes and one that does not.
        message: `No vertical datum recorded, so heights in "${record.name}" cannot be compared with confidence.`,
        subject: "geoReference.verticalDatum",
      });
    }

    if (geo.originOffset === undefined && record.extent) {
      const worst = Math.max(
        Math.abs(record.extent.xmin),
        Math.abs(record.extent.xmax),
        Math.abs(record.extent.ymin),
        Math.abs(record.extent.ymax),
      );
      if (convertLength(worst, geo.units, "m") > FLOAT_SAFE_COORDINATE_METRES) {
        issues.push({
          severity: "warning",
          code: "missing-origin-offset",
          message: `Coordinates reach ${Math.round(worst)}${geo.units} with no origin offset recorded; rendered at single precision this dataset will jitter.`,
          subject: "geoReference.originOffset",
        });
      }
    }
  }

  if (record.extent) {
    if (!extentIsValid(record.extent)) {
      issues.push({
        severity: "error",
        code: "invalid-extent",
        message: `Extent of "${record.name}" is inverted — a maximum falls below its minimum.`,
        subject: "extent",
      });
    } else {
      const units = geo?.units ?? "m";
      const span = convertLength(extentSpan(record.extent), units, "m");
      if (span > maxSpan) {
        issues.push({
          severity: "warning",
          code: "implausible-extent",
          message: `Extent spans ${Math.round(span)} m, which is more likely a unit or CRS mismatch than a genuine capture.`,
          subject: "extent",
        });
      } else if (span < minSpan) {
        issues.push({
          severity: "warning",
          code: "degenerate-extent",
          message: `Extent spans ${span} m — the dataset is effectively empty.`,
          subject: "extent",
        });
      }
    }
  }

  const derivatives = record.derivatives;
  if (derivatives && options.resolveUri) {
    for (const field of DERIVATIVE_FIELDS) {
      const uri = derivatives[field];
      if (uri === undefined) continue;
      let resolved = false;
      try {
        resolved = await options.resolveUri(uri);
      } catch {
        // A resolver that throws is reporting the same thing as one returning false — the link
        // cannot be followed — and must not take the whole report down with it.
        resolved = false;
      }
      if (!resolved) {
        issues.push({
          severity: "warning",
          code: "unresolved-derivative",
          message: `Derivative "${field}" points at "${uri}", which cannot be resolved.`,
          subject: uri,
        });
      }
    }
  }

  if (record.kind === "gaussian-splat" && derivatives?.meshUri === undefined) {
    issues.push({
      severity: "info",
      code: "splat-without-surface",
      // Stated as info because a view-only splat is a perfectly legitimate deliverable. It becomes
      // an error only where a surface is actually required — see `assertMeasurable` and promotion.
      message: `"${record.name}" is a radiance field with no derived mesh, so it can be viewed but not measured.`,
      subject: "derivatives.meshUri",
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  return { valid: errors === 0, issues, errors, warnings };
}

/**
 * The reason a dataset cannot back a measurement, as a reportable issue.
 *
 * The rule itself lives on the schema (`measurabilityReason`) so the promotion gate, a measurement
 * tool and an engine exporter all read the same one. This only turns it into a message.
 */
export function measurabilityIssue(record: TwinObjectRecord): RealityIssue | undefined {
  const reason = measurabilityReason(record);
  if (reason === "visualization-only") {
    return {
      severity: "error",
      code: "purpose-not-measurable",
      message: `"${record.name}" is marked for visualization only.`,
      subject: "purpose",
    };
  }
  if (reason === "no-surface") {
    return {
      severity: "error",
      code: "splat-without-surface",
      message: `"${record.name}" is a radiance field with no derived mesh — it has no surface to measure against.`,
      subject: "derivatives.meshUri",
    };
  }
  return undefined;
}
