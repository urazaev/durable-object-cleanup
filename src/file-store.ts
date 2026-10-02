import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface ObjectDeleter { delete(key: string): Promise<void> }

function validateKey(key: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) {
    throw new Error('Invalid object key: expected a lowercase UUID v4');
  }
}

/** Use a dedicated root owned by this process; hostile filesystem mutation is out of scope. */
export class FileObjectStore implements ObjectDeleter {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<FileObjectStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileObjectStore(await realpath(root));
  }

  /** Only the creation service may call this, after reserving a never-used key in the DB. */
  async writeNew(key: string, bytes: Uint8Array): Promise<void> {
    validateKey(key);
    const file = await open(join(this.root, key),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    const path = join(this.root, key);
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Object must be a regular file');
      await unlink(path); // unlink never follows a final-component symlink.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
