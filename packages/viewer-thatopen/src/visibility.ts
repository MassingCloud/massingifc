import type { ElementRef, Id } from "@massingifc/project-schema";
import type { VisibilityService } from "@massingifc/viewer-runtime";
import type { FragmentAppearanceSource, FragmentColor } from "./model-data.js";

/**
 * Visibility and colour overrides.
 *
 * The contract is synchronous and the engine is not: every fragments call returns a promise, and
 * the model answers from a worker. Two things follow, and both are correctness rather than taste.
 *
 * First, the override *state* is tracked here, synchronously, so `hiddenElements()` is right the
 * instant `hide()` returns rather than whenever the worker gets around to it. A UI that reads back
 * what it just wrote must not see stale state.
 *
 * Second, engine work is pushed through one serial queue. `hide(x)` immediately followed by
 * `show(x)` issues two overlapping worker round trips, and whichever finishes last wins — so
 * without ordering the element ends up hidden or shown depending on scheduling. The queue makes
 * the last call the one that decides, which is what a user pressing two buttons expects.
 */
export class ThatOpenVisibility implements VisibilityService {
  readonly #models: FragmentAppearanceSource;
  readonly #hidden = new Map<string, ElementRef>();
  readonly #coloured = new Map<string, ElementRef>();
  #queue: Promise<void> = Promise.resolve();
  #failure: unknown;

  constructor(models: FragmentAppearanceSource) {
    this.#models = models;
  }

  /** The most recent engine failure, if any. Surfaced because the contract returns `void`. */
  get lastError(): unknown {
    return this.#failure;
  }

  /** Resolves when queued engine work has drained. Tests and hosts that need to await it. */
  async settled(): Promise<void> {
    await this.#queue;
  }

  hide(elements: readonly ElementRef[]): void {
    for (const element of elements) this.#hidden.set(keyOf(element), element);
    this.#apply(elements, (model, localIds) => model.setVisible(localIds, false));
  }

  show(elements: readonly ElementRef[]): void {
    for (const element of elements) this.#hidden.delete(keyOf(element));
    this.#apply(elements, (model, localIds) => model.setVisible(localIds, true));
  }

  isolate(elements: readonly ElementRef[]): void {
    // Isolation is expressed as "everything off, then these on" rather than as a separate engine
    // mode, so it composes with hide/show instead of fighting them. `undefined` means every item.
    const keep = new Set(elements.map(keyOf));
    for (const key of [...this.#hidden.keys()]) if (keep.has(key)) this.#hidden.delete(key);

    const byModel = groupByModel(elements);
    this.#enqueue(async () => {
      for (const [modelId, refs] of byModel) {
        const model = this.#models(modelId);
        if (!model) continue;
        await model.setVisible(undefined, false);
        const localIds = await resolve(model, refs);
        if (localIds.length > 0) await model.setVisible(localIds, true);
      }
    });
  }

  showAll(): void {
    this.#hidden.clear();
    const models = this.#touchedModels();
    this.#enqueue(async () => {
      for (const modelId of models) {
        await this.#models(modelId)?.resetVisible();
      }
    });
  }

  setColor(elements: readonly ElementRef[], color: string, opacity?: number): void {
    for (const element of elements) this.#coloured.set(keyOf(element), element);
    const parsed = parseColor(color);
    // `opacity` is accepted by the contract but the colour call carries no alpha; applying it
    // would need a full material definition, so it is deliberately ignored rather than silently
    // half-applied. Recorded here so the omission is visible rather than a mystery at the callsite.
    void opacity;
    this.#apply(elements, (model, localIds) => model.setColor(localIds, parsed));
  }

  resetOverrides(): void {
    const models = this.#touchedModels();
    this.#hidden.clear();
    this.#coloured.clear();
    this.#enqueue(async () => {
      for (const modelId of models) {
        const model = this.#models(modelId);
        if (!model) continue;
        await model.resetHighlight();
        await model.resetVisible();
      }
    });
  }

  hiddenElements(): readonly ElementRef[] {
    return [...this.#hidden.values()];
  }

  /** Every model this service has touched, so a reset does not need the host to enumerate them. */
  #touchedModels(): readonly Id[] {
    const ids = new Set<Id>();
    for (const element of [...this.#hidden.values(), ...this.#coloured.values()]) {
      ids.add(element.modelId);
    }
    return [...ids];
  }

  #apply(
    elements: readonly ElementRef[],
    action: (model: NonNullable<ReturnType<FragmentAppearanceSource>>, localIds: number[]) => Promise<void>,
  ): void {
    const byModel = groupByModel(elements);
    this.#enqueue(async () => {
      for (const [modelId, refs] of byModel) {
        const model = this.#models(modelId);
        if (!model) continue;
        const localIds = await resolve(model, refs);
        if (localIds.length > 0) await action(model, localIds);
      }
    });
  }

  #enqueue(work: () => Promise<void>): void {
    this.#queue = this.#queue.then(work).catch((thrown: unknown) => {
      // A failed override must not poison the queue: the next call still has to run, or one
      // transient worker error would freeze the panel for the rest of the session.
      this.#failure = thrown;
    });
  }
}

const keyOf = (element: ElementRef): string => `${element.modelId}/${element.globalId}`;

function groupByModel(elements: readonly ElementRef[]): Map<Id, ElementRef[]> {
  const byModel = new Map<Id, ElementRef[]>();
  for (const element of elements) {
    const bucket = byModel.get(element.modelId);
    if (bucket) bucket.push(element);
    else byModel.set(element.modelId, [element]);
  }
  return byModel;
}

async function resolve(
  model: NonNullable<ReturnType<FragmentAppearanceSource>>,
  elements: readonly ElementRef[],
): Promise<number[]> {
  const locals = await model.getLocalIdsByGuids(elements.map((element) => element.globalId));
  return locals.filter((local): local is number => local !== null);
}

/** Parses `#rgb`, `#rrggbb` or `r,g,b` into the 0..1 triple the engine expects. */
export function parseColor(color: string): FragmentColor {
  const text = color.trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex?.[1]) {
    const digits =
      hex[1].length === 3
        ? [...hex[1]].map((character) => character + character).join("")
        : hex[1];
    return {
      r: Number.parseInt(digits.slice(0, 2), 16) / 255,
      g: Number.parseInt(digits.slice(2, 4), 16) / 255,
      b: Number.parseInt(digits.slice(4, 6), 16) / 255,
    };
  }

  const parts = text.split(",").map((part) => Number.parseFloat(part));
  if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
    const scale = parts.some((part) => part > 1) ? 255 : 1;
    return { r: parts[0]! / scale, g: parts[1]! / scale, b: parts[2]! / scale };
  }

  // An unparseable colour becomes a visible magenta rather than black: silently painting elements
  // the same colour as a shadow is how a broken override goes unnoticed.
  return { r: 1, g: 0, b: 1 };
}
