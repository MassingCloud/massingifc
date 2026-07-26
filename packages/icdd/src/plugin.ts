import { createCapabilityToken, err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import { definePlugin, systemClock, type Clock, type Plugin } from "@massingifc/plugin-sdk";
import { MemoryArchive, type ContainerArchive } from "./archive.js";
import {
  readContainer,
  writeContainer,
  type IcddContainer,
  type LinkSpec,
  type LinksetSpec,
  type ReadContainerResult,
  type WriteContainerOptions,
} from "./container.js";
import { LINK_TYPES, type ExtendedLinkType } from "./ontology.js";
import { validateContainer, type ContainerValidationReport } from "./validation.js";

export interface IcddService {
  /** Assembles the RDF side of a container into an archive the host supplies. */
  write(
    archive: ContainerArchive,
    container: IcddContainer,
    options?: WriteContainerOptions,
  ): Promise<Result<void>>;
  read(archive: ContainerArchive): Promise<Result<ReadContainerResult>>;
  validate(archive: ContainerArchive): Promise<Result<ContainerValidationReport>>;
  /** The nine ISO 21597-2 families expressed as fifteen link classes. */
  linkTypes(): readonly (typeof LINK_TYPES)[ExtendedLinkType][];
  /** Produces the inverse of a directed link, or `undefined` for a symmetric one. */
  invert(link: LinkSpec): LinkSpec | undefined;
  newArchive(): ContainerArchive;
}

export const IcddToken = createCapabilityToken<IcddService>("interop.icdd");

export const ICDD_COMMANDS = {
  readContainer: "icdd.container.read",
  writeContainer: "icdd.container.write",
  validateContainer: "icdd.container.validate",
} as const;

export interface IcddPluginOptions {
  readonly clock?: Clock;
}

/**
 * Inverts a directed link by swapping its endpoints and its class.
 *
 * Both halves change together. Swapping only the endpoints would leave a `HasPart` link asserting
 * that the whole is a part of its component — a statement that reads as valid RDF and is exactly
 * backwards.
 */
export function invertLink(link: LinkSpec): LinkSpec | undefined {
  const descriptor = link.type in LINK_TYPES ? LINK_TYPES[link.type as ExtendedLinkType] : undefined;
  if (!descriptor?.directed || !descriptor.inverse) return undefined;
  return {
    ...(link.id === undefined ? {} : { id: `${link.id}-inverse` }),
    type: descriptor.inverse,
    ...(link.to === undefined ? {} : { from: link.to }),
    ...(link.from === undefined ? {} : { to: link.from }),
  };
}

export function createIcddPlugin(options: IcddPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;

  return definePlugin({
    id: "massingifc.icdd",
    version: "0.1.0",
    name: "ISO 21597 (ICDD)",
    description: "Read, write and validate ISO 21597 information containers.",

    activate(context) {
      const service: IcddService = {
        async write(archive, container, writeOptions) {
          try {
            await writeContainer(archive, container, writeOptions ?? {});
            context.events.emit("icdd.container.written", {
              containerId: container.description.id,
              documents: container.documents.length,
              linksets: container.linksets.length,
              at: clock.timestamp(),
            });
            return ok(undefined);
          } catch (thrown) {
            return err(
              new KernelError("COMMAND_FAILED", "Failed to write ICDD container.", {}, { cause: thrown }),
            );
          }
        },

        async read(archive) {
          try {
            return ok(await readContainer(archive));
          } catch (thrown) {
            return err(
              new KernelError(
                "COMMAND_FAILED",
                thrown instanceof Error ? thrown.message : "Failed to read ICDD container.",
                {},
                { cause: thrown },
              ),
            );
          }
        },

        async validate(archive) {
          try {
            const report = await validateContainer(archive);
            context.events.emit("icdd.container.validated", {
              conformant: report.conformant,
              errors: report.errors,
              warnings: report.warnings,
            });
            return ok(report);
          } catch (thrown) {
            return err(
              new KernelError("COMMAND_FAILED", "Failed to validate ICDD container.", {}, { cause: thrown }),
            );
          }
        },

        linkTypes: () => Object.values(LINK_TYPES),
        invert: invertLink,
        newArchive: () => new MemoryArchive(),
      };

      context.capabilities.provide(IcddToken, service, { version: "0.1.0" });

      context.commands.register<{ archive: ContainerArchive }, ReadContainerResult>({
        id: ICDD_COMMANDS.readContainer,
        title: "Open ICDD container",
        handler: async ({ archive }) => {
          const read = await service.read(archive);
          if (!read.ok) throw read.error;
          return read.value;
        },
      });

      context.commands.register<
        { archive: ContainerArchive; container: IcddContainer; options?: WriteContainerOptions },
        void
      >({
        id: ICDD_COMMANDS.writeContainer,
        title: "Write ICDD container",
        handler: async ({ archive, container, options: writeOptions }) => {
          const written = await service.write(archive, container, writeOptions);
          if (!written.ok) throw written.error;
        },
      });

      context.commands.register<{ archive: ContainerArchive }, ContainerValidationReport>({
        id: ICDD_COMMANDS.validateContainer,
        title: "Validate ICDD container",
        handler: async ({ archive }) => {
          const validated = await service.validate(archive);
          if (!validated.ok) throw validated.error;
          return validated.value;
        },
      });

      context.ui.register({
        id: "icdd.panel",
        point: "panel",
        title: "Information containers",
        placement: "right",
        order: 60,
      });

      context.logger.info("ICDD capability ready", { linkTypes: Object.keys(LINK_TYPES).length });
    },
  });
}

export const icddPlugin = createIcddPlugin();

/** Convenience for the common case of one linkset holding a batch of links. */
export function singleLinkset(
  id: string,
  name: string,
  links: readonly LinkSpec[],
  filename = `${id}.rdf`,
): LinksetSpec {
  return { id, name, filename, links };
}
