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
    await archive.write(payload.path, bytes);
  }

  await archive.write(SCENE_MANIFEST_PATH, encoder.encode(JSON.stringify(scene, undefined, 2)));
  return ok(undefined);
}

export interface ReadSceneResult {
  readonly scene: ScenePackage;
  readPayload(payloadId: string): Promise<Uint8Array | undefined>;
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
  if (!Array.isArray(scene.nodes) || typeof scene.index !== "object" || scene.index === null) {
    return err(new KernelError("COMMAND_FAILED", "Scene manifest is missing nodes or index.", {}));
  }

  const byId = new Map(scene.payloads?.map((payload) => [payload.id, payload]) ?? []);
  return ok({
    scene,
    async readPayload(payloadId) {
      const payload = byId.get(payloadId);
      return payload === undefined ? undefined : archive.read(payload.path);
    },
  });
}
