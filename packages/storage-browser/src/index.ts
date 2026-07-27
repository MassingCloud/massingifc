/**
 * `@massingifc/storage-browser` — IndexedDB persistence for browser hosts.
 *
 * A **platform adapter**, like `storage-node`: it uses browser APIs deliberately, which is why it
 * is a separate package. Both implement the same `StorageAdapter`, so nothing above changes.
 */
export {
  IndexedDbStorageAdapter,
  type IndexedDbStorageOptions,
} from "./indexeddb.js";
