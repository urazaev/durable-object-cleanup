import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileObjectStore } from '../src/file-store.js';

test('flat generation keys are confined, immutable and idempotently deleted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cleanup-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileObjectStore.open(root);
  const key = randomUUID();
  await store.writeNew(key, Buffer.from('original'));
  await assert.rejects(store.writeNew(key, Buffer.from('replacement')), /EEXIST/);
  for (const invalid of ['../outside', '/tmp/outside', `${key}/child`, '', key.toUpperCase()]) {
    await assert.rejects(store.delete(invalid), /Invalid object key/);
  }
  assert.equal(await readFile(join(root, key), 'utf8'), 'original');
  await store.delete(key);
  await store.delete(key);
});

test('a symlink key cannot lead the adapter outside its root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cleanup-store-'));
  const outside = await mkdtemp(join(tmpdir(), 'cleanup-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const target = join(outside, 'must-survive');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(target, 'safe');
  const key = randomUUID();
  await symlink(target, join(root, key));
  const store = await FileObjectStore.open(root);
  await assert.rejects(store.writeNew(key, Buffer.from('unsafe')), /EEXIST/);
  await assert.rejects(store.delete(key), /regular file/);
  assert.equal(await readFile(target, 'utf8'), 'safe');
});
