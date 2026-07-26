/**
 * Container file access, as a port.
 *
 * ISO 21597 containers are ZIP packages (ISO/IEC 21320-1), but this package deliberately does not
 * implement ZIP. Compression belongs to the host: a browser has `CompressionStream`, Node has
 * `node:zlib`, and a server may already stream containers straight from object storage. Taking a
 * ZIP dependency here would force one of those choices on every deployment and would put a
 * platform-specific binary in the middle of an otherwise portable package.
 *
 * Everything above this interface deals only in paths and bytes.
 */
export interface ContainerArchive {
  /** Every entry path in the archive, using `/` separators and no leading slash. */
  entries(): Promise<readonly string[]>;
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete?(path: string): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export const encodeText = (text: string): Uint8Array => encoder.encode(text);
export const decodeTextBytes = (bytes: Uint8Array): string => decoder.decode(bytes);

/** Normalises separators and strips leading `./` or `/` so lookups are comparable. */
export function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

export class MemoryArchive implements ContainerArchive {
  readonly #files = new Map<string, Uint8Array>();

  constructor(initial: Readonly<Record<string, Uint8Array | string>> = {}) {
    for (const [path, value] of Object.entries(initial)) {
      this.#files.set(
        normalisePath(path),
        typeof value === "string" ? encodeText(value) : value,
      );
    }
  }

  async entries(): Promise<readonly string[]> {
    return [...this.#files.keys()].sort();
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    return this.#files.get(normalisePath(path));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.#files.set(normalisePath(path), data);
  }

  async delete(path: string): Promise<void> {
    this.#files.delete(normalisePath(path));
  }

  /** Convenience for tests and inspection. */
  readText(path: string): string | undefined {
    const bytes = this.#files.get(normalisePath(path));
    return bytes === undefined ? undefined : decodeTextBytes(bytes);
  }

  get size(): number {
    return this.#files.size;
  }
}

export async function readArchiveText(
  archive: ContainerArchive,
  path: string,
): Promise<string | undefined> {
  const bytes = await archive.read(path);
  return bytes === undefined ? undefined : decodeTextBytes(bytes);
}

export async function writeArchiveText(
  archive: ContainerArchive,
  path: string,
  text: string,
): Promise<void> {
  await archive.write(path, encodeText(text));
}
