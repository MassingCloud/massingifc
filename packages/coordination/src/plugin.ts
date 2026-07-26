import type { ClashStatus, ClashTestRecord, Id } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  ClashEngineToken,
  ClashToken,
  COORDINATION_COMMANDS,
  COORDINATION_PERMISSIONS,
  IssueRoutingToken,
  ModelSnapshotToken,
  ResponsibilityMatrixToken,
  RevisionDiffToken,
  ValidationRuleToken,
  ValidationToken,
} from "./contracts.js";
import {
  createClashService,
  createCoordinationStores,
  createIssueRoutingService,
  createResponsibilityService,
  createRevisionDiffService,
  createValidationService,
  type IssueLike,
} from "./services.js";

export interface CoordinationPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  /** Elements belonging to a model. Supplied by the host's federation or viewer layer. */
  readonly elementsOf?: (modelId: Id) => readonly { modelId: Id; globalId: string }[];
  /** Issues available for routing. Normally backed by the markup plugin. */
  readonly issues?: () => readonly IssueLike[];
}

/**
 * The coordination capability.
 *
 * Built around re-runnability. Coordination is a weekly cycle, and a contract that mints fresh
 * identities on every run throws away the triage done last week — so clashes carry a stable
 * signature and diffs are computed between named revisions.
 */
export function createCoordinationPlugin(options: CoordinationPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();
  const elementsOf = options.elementsOf ?? (() => []);
  const issueSource = options.issues ?? (() => []);

  return definePlugin({
    id: "massingifc.coordination",
    version: "0.1.0",
    name: "Coordination",
    description: "Clash detection, validation, issue routing and revision diffing.",
    permissions: Object.values(COORDINATION_PERMISSIONS),

    activate(context) {
      const stores = createCoordinationStores(context);
      const runtime = {
        context,
        clock,
        ids,
        engine: () => context.capabilities.get(ClashEngineToken),
        snapshots: () => context.capabilities.get(ModelSnapshotToken),
        validationRules: () => context.capabilities.getAll(ValidationRuleToken).map((p) => p.value),
        elementsOf,
      };

      const clash = createClashService(runtime, stores);
      const validation = createValidationService(runtime, stores);
      const diffs = createRevisionDiffService(runtime, stores);
      const responsibility = createResponsibilityService(runtime, stores);
      const routing = createIssueRoutingService(runtime, stores, issueSource, (issueId, changes) =>
        context.commands.execute("markup.issue.update", { id: issueId, ...changes }),
      );

      context.capabilities.provide(ClashToken, clash, { version: "0.1.0" });
      context.capabilities.provide(ValidationToken, validation, { version: "0.1.0" });
      context.capabilities.provide(RevisionDiffToken, diffs, { version: "0.1.0" });
      context.capabilities.provide(IssueRoutingToken, routing, { version: "0.1.0" });
      context.capabilities.provide(ResponsibilityMatrixToken, responsibility, { version: "0.1.0" });

      context.commands.register<Omit<ClashTestRecord, "id">, ClashTestRecord>({
        id: COORDINATION_COMMANDS.defineClashTest,
        title: "Define clash test",
        permission: COORDINATION_PERMISSIONS.manageRules,
        handler: async (params) => {
          const defined = await clash.defineTest(params);
          if (!defined.ok) throw defined.error;
          return defined.value;
        },
      });

      context.commands.register<{ testId: Id }, unknown>({
        id: COORDINATION_COMMANDS.runClashTest,
        title: "Run clash test",
        permission: COORDINATION_PERMISSIONS.runTests,
        handler: async ({ testId }) => {
          const run = await clash.run(testId);
          if (!run.ok) throw run.error;
          return run.value;
        },
      });

      context.commands.register<{ clashId: Id; status: ClashStatus }, unknown>({
        id: COORDINATION_COMMANDS.setClashStatus,
        title: "Set clash status",
        permission: COORDINATION_PERMISSIONS.triage,
        handler: async ({ clashId, status }) => {
          const set = await clash.setStatus(clashId, status);
          if (!set.ok) throw set.error;
          return set.value;
        },
      });

      context.commands.register<{ clashId: Id; assignee?: Id }, Id>({
        id: COORDINATION_COMMANDS.promoteClashToIssue,
        title: "Raise issue from clash",
        permission: COORDINATION_PERMISSIONS.triage,
        handler: async ({ clashId, assignee }) => {
          const promoted = await clash.promoteToIssue(clashId, assignee);
          if (!promoted.ok) throw promoted.error;
          return promoted.value;
        },
      });

      context.commands.register<{ ruleIds?: readonly Id[]; modelIds?: readonly Id[] }, unknown>({
        id: COORDINATION_COMMANDS.runValidation,
        title: "Run validation",
        permission: COORDINATION_PERMISSIONS.runTests,
        handler: async (params) => {
          const run = await validation.run(params);
          if (!run.ok) throw run.error;
          return run.value;
        },
      });

      context.commands.register<{ modelId: Id; fromVersion: string; toVersion: string }, unknown>({
        id: COORDINATION_COMMANDS.compareRevisions,
        title: "Compare revisions",
        permission: COORDINATION_PERMISSIONS.runTests,
        handler: async ({ modelId, fromVersion, toVersion }) => {
          const compared = await diffs.compare(modelId, fromVersion, toVersion);
          if (!compared.ok) throw compared.error;
          return compared.value;
        },
      });

      context.commands.register<{ issueIds?: readonly Id[] }, unknown>({
        id: COORDINATION_COMMANDS.routeIssues,
        title: "Route issues",
        permission: COORDINATION_PERMISSIONS.triage,
        handler: async ({ issueIds }) => {
          const routed = await routing.route(issueIds);
          if (!routed.ok) throw routed.error;
          return routed.value;
        },
      });

      context.ui.register({ id: "coordination.clash", point: "panel", title: "Clashes", placement: "right", order: 30 });
      context.ui.register({ id: "coordination.validation", point: "panel", title: "Validation", placement: "right", order: 35 });

      context.logger.info("Coordination capability ready");
    },
  });
}

export const coordinationPlugin = createCoordinationPlugin();
