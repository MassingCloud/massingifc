import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import { definePlugin, type Plugin } from "@massingifc/plugin-sdk";
import { ExportAdapterToken, type ExportAdapter } from "@massingifc/interop";
import type { Id } from "@massingifc/project-schema";
import {
  ENGINE_BRIDGE_FORMAT,
  ScenePackageProviderToken,
  type ScenePackage,
  type ScenePackageProvider,
} from "./contracts.js";
import { validateScenePackage } from "./build.js";
import { writeScenePackage, type SceneArchive } from "./codec.js";

const encoder = new TextEncoder();

export interface SceneExportOptions {
  readonly modelIds?: readonly Id[];
  readonly includeProperties?: boolean;
  readonly includeRelationships?: boolean;
}

/**
 * Exports the scene manifest.
 *
 * Returns the manifest alone rather than a packaged archive because this package does not
 * implement ZIP — the same reasoning as the ICDD container. The manifest is self-describing and
 * names its payload paths, and a host that wants one file calls `writeScenePackage` with the
 * bundle's payloads and an archive it owns. Pretending to produce a package here would mean
 * picking a compression implementation on every deployment's behalf, and an `ExportAdapter`
 * returns a single `Uint8Array`, which a multi-file package is not.
 */
export function createSceneExportAdapter(
  resolveProvider: () => ScenePackageProvider | undefined,
): ExportAdapter {
  return {
    format: {
      id: ENGINE_BRIDGE_FORMAT.id,
      label: ENGINE_BRIDGE_FORMAT.label,
      extensions: [".json"],
      mimeType: "application/json",
    },
    async export(options) {
      const provider = resolveProvider();
      if (!provider) {
        return err(
          new KernelError(
            "CAPABILITY_NOT_FOUND",
            "No scene package provider is installed, so there is nothing to export.",
            {},
          ),
        );
      }

      const scope = (options.scope ?? {}) as SceneExportOptions;
      const built = await provider.build({
        ...(scope.modelIds === undefined ? {} : { modelIds: scope.modelIds }),
        ...(scope.includeProperties === undefined ? {} : { includeProperties: scope.includeProperties }),
        ...(scope.includeRelationships === undefined
          ? {}
          : { includeRelationships: scope.includeRelationships }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!built.ok) return err(built.error);

      const report = validateScenePackage(built.value.scene);
      if (!report.valid) {
        // Exporting a scene with a stale index or a missing payload would fail inside a consumer
        // written in another language, where the message is far less useful than it is here.
        const first = report.issues.find((issue) => issue.severity === "error");
        return err(
          new KernelError("COMMAND_FAILED", `Scene package is not exportable: ${first?.message}`, {
            issues: report.issues.length,
          }),
        );
      }

      return ok(encoder.encode(JSON.stringify(built.value.scene)));
    },
  };
}

/**
 * The engine bridge capability.
 *
 * Neutral by design. The platform will need a real-time engine for rendering, and the durable part
 * of that work is the conversion contract, not the engine plugin — so this defines a scene package
 * an Unreal, Unity, Bevy or native consumer can read, and stops there. A vendor-specific layer can
 * be added later without changing anything upstream of it; a vendor-specific contract could not
 * have been.
 */
export function createEngineBridgePlugin(): Plugin {
  return definePlugin({
    id: "massingifc.engine-bridge",
    version: "0.1.0",
    name: "Engine bridge",
    description: "Engine-neutral scene packages for real-time consumers.",
    permissions: ["interop.export"],

    activate(context) {
      const provider = (): ScenePackageProvider | undefined =>
        context.capabilities.get(ScenePackageProviderToken);

      context.capabilities.provide(ExportAdapterToken, createSceneExportAdapter(provider), {
        version: "0.1.0",
      });

      context.commands.register<
        { readonly archive: SceneArchive; readonly scene: ScenePackage; readonly payloads?: ReadonlyMap<string, Uint8Array> },
        void
      >({
        id: "engine.scene.write",
        title: "Write scene package",
        permission: "interop.export",
        handler: async ({ archive, scene, payloads }) => {
          const written = await writeScenePackage(archive, scene, {
            ...(payloads === undefined ? {} : { payloads }),
          });
          if (!written.ok) throw written.error;
        },
      });

      context.logger.info("Engine bridge ready");
    },
  });
}

export const engineBridgePlugin = createEngineBridgePlugin();

/** Convenience for hosts that already hold a package and just want it on disk. */
export async function exportScenePackage(
  archive: SceneArchive,
  scene: ScenePackage,
  payloads?: ReadonlyMap<string, Uint8Array>,
): Promise<Result<void>> {
  const report = validateScenePackage(scene);
  if (!report.valid) {
    const first = report.issues.find((issue) => issue.severity === "error");
    return err(
      new KernelError("COMMAND_FAILED", `Scene package is not exportable: ${first?.message}`, {
        issues: report.issues.length,
      }),
    );
  }
  return writeScenePackage(archive, scene, { ...(payloads === undefined ? {} : { payloads }) });
}
