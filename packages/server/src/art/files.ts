import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileRef } from "@anomaly/core";

/**
 * Content-addressed binary files for a project (<projectDir>/files/<sha>.<ext>).
 * Immutable: a ref always means the same bytes, so undo just points back at
 * an older ref and nothing is ever overwritten.
 */
export class FileStore {
  readonly dir: string;

  constructor(projectDir: string) {
    this.dir = join(projectDir, "files");
  }

  async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
    const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 40)}.${ext}`;
    const path = join(this.dir, ref);
    try {
      await stat(path);
      return ref; // already stored
    } catch {
      // not stored yet
    }
    await mkdir(this.dir, { recursive: true });
    // Unique per write: the same bytes can be stored twice at once (parallel jobs, identical images).
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
    return ref;
  }

  async get(ref: FileRef): Promise<Buffer> {
    return readFile(this.path(ref));
  }

  /** Absolute path of a valid ref; throws on anything else (no path tricks). */
  path(ref: string): string {
    if (!FileRef.safeParse(ref).success) throw new Error(`invalid file ref "${ref}"`);
    return join(this.dir, ref);
  }
}

export const FILE_MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
