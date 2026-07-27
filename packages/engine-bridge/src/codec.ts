import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import {
  SCENE_FORMAT_VERSION,
  SCENE_MANIFEST_PATH,
  SCENE_PAYLOAD_DIRECTORY,
  type ScenePackage,
} from "./contracts.js";

/**
 * Package file access, as a port.
 *
 * Same reasoning as the ICDD container: a package is a directory or a ZIP depending on where it is
 * going, and compression belongs to whoever knows the environment. Deliberately structurally
 * identical to `ContainerArchive` so an implementation written for one works for the other without
 * an adapter, while neither package has to depend on the other.
 */
export interface SceneArchive {
  entries(): Promise<readonly string[]>;
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, data: Uint8Array): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Normalises a package-relative path and refuses any that escapes the package.
 *
 * Paths in a manifest are file *content*, not caller input, and a package can arrive from anywhere.
 * A declared path of `../../../.ssh/id_rsa` handed to a filesystem-backed archive reads — or on
 * write, clobbers — a file outside the package. The ICDD container normalises every entry path for
 * the same reason; there is no case where a payload legitimately lives outside its own package.
 */
export function safePayloadPath(path: string): string | undefined {
  const normalised = path.replace(/\\/g, "/");
  // Absoluteness is checked before any stripping. Removing a leading slash first would quietly
  // turn "/etc/passwd" into a package-relative path and read a different file than was asked for,
  // which is a worse answer than refusing.
  if (normalised.length === 0 || normalised.startsWith("/") || /^[A-Za-z]:/.test(normalised)) {
    return undefined;
  }
  const segments = normalised.replace(/^\.\//, "").split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    return undefined;
  }
  return segments.join("/");
}

export function payloadPath(payloadId: string, extension = "bin"): string {
  // Payload ids come from exporters and can carry characters that are legal in JSON and illegal in
  // a file name; percent-encoding everything outside a conservative set keeps the mapping total.
  const safe = [...payloadId]
    .map((character) =>
      /[A-Za-z0-9._-]/.test(character)
        ? character
        : [...encoder.encode(character)]
            .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
            .join(""),
    )
    .join("");
  return `${SCENE_PAYLOAD_DIRECTORY}/${safe.length === 0 ? "%" : safe}.${extension}`;
}

export interface WriteSceneOptions {
  /** Payload bytes by payload id. Every payload declared in the manifest must be present. */
  readonly payloads?: ReadonlyMap<string, Uint8Array>;
}

/**
 * Writes a package into an archive.
 *
 * Manifest and payloads stay separate files rather than one embedded blob: an engine importer
 * wants to parse a few hundred kilobytes of JSON and then memory-map or stream geometry it may
 * never fully load. Base64 inside JSON would force the whole model through a parser and inflate it
 * by a third, which is exactly the load pattern large models cannot afford.
 */
export async function writeScenePackage(
  archive: SceneArchive,
  scene: ScenePackage,
  options: WriteSceneOptions = {},
): Promise<Result<void>> {
  const supplied = options.payloads ?? new Map<string, Uint8Array>();

  for (const payload of scene.payloads) {
    const bytes = supplied.get(payload.id);
    if (!bytes) {
      return err(
        new KernelError("COMMAND_FAILED", `No bytes supplied for payload "${payload.id}".`, {
          payloadId: payload.id,
        }),
      );
    }
    if (bytes.byteLength !== payload.byteLength) {
      // A declared length that disagrees with the bytes means a consumer reading by offset gets
      // garbage, and it will blame the geometry rather than the manifest.
      return err(
        new KernelError(
          "COMMAND_FAILED",
          `Payload "${payload.id}" declares ${payload.byteLength} bytes but ${bytes.byteLength} were supplied.`,
          { payloadId: payload.id },
        ),
      );
    }
    const path = safePayloadPath(payload.path);
    if (path === undefined) {
      return err(
        new KernelError("COMMAND_FAILED", `Payload "${payload.id}" declares a path outside the package.`, {
          payloadId: payload.id,
          path: payload.path,
        }),
      );
    }
    await archive.write(path, bytes);
  }

  await archive.write(SCENE_MANIFEST_PATH, encoder.encode(JSON.stringify(scene, undefined, 2)));
  return ok(undefined);
}

export interface ReadSceneResult {
  readonly scene: ScenePackage;
  readPayload(payloadId: string): Promise<Uint8Array | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isIndex(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["byClass", "byLevel", "byGlobalId"].every((key) => isRecord(value[key]));
}

const majorOf = (version: string): string => version.split(".")[0] ?? version;

/**
 * Reads a package from an archive.
 *
 * Refuses a major version it does not know instead of reading what it recognises. A partially
 * understood scene loads looking correct with pieces missing, and nothing in the result says so.
 */
export async function readScenePackage(archive: SceneArchive): Promise<Result<ReadSceneResult>> {
  const manifestBytes = await archive.read(SCENE_MANIFEST_PATH);
  if (!manifestBytes) {
    return err(
      new KernelError("COMMAND_FAILED", `Package has no "${SCENE_MANIFEST_PATH}".`, {
        path: SCENE_MANIFEST_PATH,
      }),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(manifestBytes));
  } catch (cause) {
    return err(
      new KernelError("COMMAND_FAILED", "Scene manifest is not valid JSON.", {
        cause: String(cause),
      }),
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    return err(new KernelError("COMMAND_FAILED", "Scene manifest is not an object.", {}));
  }

  const scene = parsed as ScenePackage;
  if (typeof scene.formatVersion !== "string") {
    return err(new KernelError("COMMAND_FAILED", "Scene manifest declares no format version.", {}));
  }
  if (majorOf(scene.formatVersion) !== majorOf(SCENE_FORMAT_VERSION)) {
    return err(
      new KernelError(
        "COMMAND_FAILED",
        `Scene format ${scene.formatVersion} cannot be read by a ${SCENE_FORMAT_VERSION} reader.`,
        { formatVersion: scene.formatVersion },
      ),
    );
  }
  if (!Array.isArray(scene.nodes)) {
    return err(new KernelError("COMMAND_FAILED", "Scene manifest is missing its nodes.", {}));
  }
  if (!isIndex(scene.index)) {
    // Checked in full because consumers read `index.byGlobalId` without guarding: an index that
    // merely exists lets the reader return `ok` and the first query throw.
    return err(
      new KernelError("COMMAND_FAILED", "Scene manifest has no usable index.", {
        index: typeof scene.index,
      }),
    );
  }

  const byId = new Map(scene.payloads?.map((payload) => [payload.id, payload]) ?? []);
  return ok({
    scene,
    async readPayload(payloadId) {
      const payload = byId.get(payloadId);
      if (payload === undefined) return undefined;
      const path = safePayloadPath(payload.path);
      // A manifest is file content, not caller input. An escaping path is refused, not followed.
      return path === undefined ? undefined : archive.read(path);
    },
  });
}
