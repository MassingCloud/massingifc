/**
 * `@massingifc/storage-node` — filesystem persistence for Node hosts.
 *
 * A **platform adapter**: it uses `node:` built-ins deliberately, which is why it is a separate
 * package rather than part of the kernel. A browser host supplies an IndexedDB adapter against the
 * same `StorageAdapter` interface and nothing above changes.
 */
export {
  FileSystemStorageAdapter,
  KeyEscapeError,
  resolveKeyPath,
  type FileSystemStorageOptions,
} from "./filesystem.js";
