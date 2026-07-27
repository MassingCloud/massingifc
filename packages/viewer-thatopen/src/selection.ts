import type { Id } from "@massingifc/project-schema";
import type { ElementRef } from "@massingifc/project-schema";
import type { SelectionService } from "@massingifc/viewer-runtime";

/**
 * Selection that publishes GlobalIds.
 *
 * Deliberately holds `ElementRef`, never raw local ids: this is the boundary the contracts require
 * picks to be resolved at, and the type makes it impossible to publish a transient identity.
 */
export class ThatOpenSelection implements SelectionService {
  #current: ElementRef[] = [];
  readonly #sets = new Map<Id, ElementRef[]>();
  #nextSetId = 1;

  get(): readonly ElementRef[] {
    return this.#current;
  }

  set(elements: readonly ElementRef[]): void {
    this.#current = [...elements];
  }

  add(elements: readonly ElementRef[]): void {
    const seen = new Set(this.#current.map((e) => `${e.modelId}/${e.globalId}`));
    for (const element of elements) {
      const key = `${element.modelId}/${element.globalId}`;
      if (!seen.has(key)) {
        seen.add(key);
        this.#current.push(element);
      }
    }
  }

  clear(): void {
    this.#current = [];
  }

  saveSet(name: string, elements: readonly ElementRef[]): Id {
    const id = `${name}-${this.#nextSetId++}`;
    this.#sets.set(id, [...elements]);
    return id;
  }

  restoreSet(setId: Id): readonly ElementRef[] {
    return this.#sets.get(setId) ?? [];
  }
}
