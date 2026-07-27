import type { StorageAdapter } from "@massingifc/core-kernel";

/**
 * IndexedDB-backed storage.
 *
 * The browser counterpart to `storage-node`. Two things make it preferable to `localStorage` for
 * this job: it stores structured values including `Uint8Array` natively — so model payloads need no
 * base64 round-trip and no size inflation — and it is asynchronous, so writing a large project does
 * not block the frame.
 */

export interface IndexedDbStorageOptions {
  /** Database name. One per project keeps unrelated projects from sharing a quota failure. */
  readonly databaseName?: string;
  readonly storeName?: string;
  /** Injectable for tests and non-window contexts such as a worker. */
  readonly factory?: IDBFactory;
  /**
   * Key-range constructor, injected alongside the factory.
   *
   * Both are globals in a browser and neither is in Node. Taking the factory but reaching for the
   * global range constructor made the adapter only *half* injectable — it opened fine against a
   * supplied implementation and then threw on the first prefix query.
   */
  readonly keyRange?: typeof IDBKeyRange;
}

const DEFAULT_DATABASE = "massingifc";
const DEFAULT_STORE = "documents";

/** Wraps a request in a promise, preserving the underlying DOMException as the rejection. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Waits for a transaction to finish, not merely for its requests to succeed.
 *
 * A request succeeding does not mean the data is durable — the transaction can still abort, on a
 * quota error most commonly. Resolving on the request would report a successful save for data that
 * was then thrown away.
 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Transaction failed"));
  });
}

export class IndexedDbStorageAdapter implements StorageAdapter {
  readonly #databaseName: string;
  readonly #storeName: string;
  readonly #factory: IDBFactory;
  readonly #keyRange: typeof IDBKeyRange | undefined;
  #database: IDBDatabase | undefined;
  #opening: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbStorageOptions = {}) {
    this.#databaseName = options.databaseName ?? DEFAULT_DATABASE;
    this.#storeName = options.storeName ?? DEFAULT_STORE;
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) {
      throw new Error(
        "IndexedDB is not available. Pass a factory, or use a different StorageAdapter.",
      );
    }
    this.#factory = factory;
    this.#keyRange = options.keyRange ?? globalThis.IDBKeyRange;
  }

  /** Opens once and reuses. Concurrent callers share the same in-flight open. */
  async #open(): Promise<IDBDatabase> {
    if (this.#database) return this.#database;
    if (this.#opening) return this.#opening;

    this.#opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(this.#databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.#storeName)) {
          database.createObjectStore(this.#storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to open the database"));
      request.onblocked = () =>
        reject(new Error("Another tab is holding an older version of the database open."));
    });

    try {
      this.#database = await this.#opening;
      return this.#database;
    } finally {
      this.#opening = undefined;
    }
  }

  async #store(mode: IDBTransactionMode): Promise<{
    store: IDBObjectStore;
    transaction: IDBTransaction;
  }> {
    const database = await this.#open();
    const transaction = database.transaction(this.#storeName, mode);
    return { store: transaction.objectStore(this.#storeName), transaction };
  }

  async get(key: string): Promise<unknown | undefined> {
    const { store } = await this.#store("readonly");
    const value = await promisify(store.get(key));
    // IndexedDB returns undefined for a missing key, which is the same thing absence means here.
    return value === undefined ? undefined : value;
  }

  async put(key: string, value: unknown): Promise<void> {
    const { store, transaction } = await this.#store("readwrite");
    store.put(structuredCloneIfNeeded(value), key);
    // Awaiting the transaction rather than the request is what makes this durable.
    await transactionDone(transaction);
  }

  async delete(key: string): Promise<void> {
    const { store, transaction } = await this.#store("readwrite");
    store.delete(key);
    await transactionDone(transaction);
  }

  async keys(prefix = ""): Promise<string[]> {
    const { store } = await this.#store("readonly");
    // A bounded range asks the index for the prefix rather than reading every key and filtering,
    // which matters once a project holds tens of thousands of records. The upper bound uses U+FFFF
    // so `markup:` cannot swallow a neighbouring `markupX`.
    const range =
      prefix === "" || !this.#keyRange
        ? undefined
        : this.#keyRange.bound(prefix, `${prefix}￿`, false, false);

    const keys = await promisify(store.getAllKeys(range));
    const listed = keys.map(String);
    // Falls back to filtering if no range constructor was available, so a host that supplies only
    // a factory still gets correct results rather than every key in the store.
    return (range ? listed : listed.filter((key) => key.startsWith(prefix))).sort();
  }

  /** Closes the connection. A host should call this when tearing a project down. */
  close(): void {
    this.#database?.close();
    this.#database = undefined;
  }

  /** Deletes the whole database. Used when discarding a project's local cache. */
  async destroy(): Promise<void> {
    this.close();
    await new Promise<void>((resolve, reject) => {
      const request = this.#factory.deleteDatabase(this.#databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Failed to delete the database"));
      request.onblocked = () => resolve(); // will complete once other connections close
    });
  }
}

/**
 * IndexedDB structured-clones on write, and will throw on a value it cannot clone.
 *
 * Cloning here first turns "the transaction aborted" — reported asynchronously and hard to trace —
 * into a synchronous error naming the value, at the call site that supplied it.
 */
function structuredCloneIfNeeded(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (typeof structuredClone !== "function") return value;
  try {
    return structuredClone(value);
  } catch (thrown) {
    throw new Error(
      `Value is not storable: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
}
