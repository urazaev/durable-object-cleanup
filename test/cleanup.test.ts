import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { FileObjectStore } from '../src/file-store.js';
import { createObject, queueDeletion, runCleanupOnce } from '../src/cleanup.js';

const databaseURL = process.env.TEST_DATABASE_URL;
if (!databaseURL) throw new Error('Set TEST_DATABASE_URL to a disposable local PostgreSQL database');
const database = new URL(databaseURL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) {
  throw new Error('Tests only accept a loopback PostgreSQL database');
}

async function fixture(t: TestContext) {
  const schema = `cleanup_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseURL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}`, max: 6 });
  const root = await mkdtemp(join(tmpdir(), 'cleanup-integration-'));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const store = await FileObjectStore.open(root);
  const create = () => createObject(pool, store, 'example', Buffer.from('original'));
  return { pool, root, store, create, schema };
}

test('references prevent deletion; a committed delete leaves a durable job', async (t) => {
  const { pool, store, root, create } = await fixture(t);
  const key = await create();
  await pool.query('INSERT INTO object_references(id, object_key) VALUES ($1, $2)', [randomUUID(), key]);
  await assert.rejects(queueDeletion(pool, key), /referenced|foreign key/i);
  assert.equal((await pool.query('SELECT * FROM cleanup_jobs')).rowCount, 0);
  await pool.query('DELETE FROM object_references');
  assert.equal(await queueDeletion(pool, key), true);
  assert.equal((await pool.query('SELECT * FROM objects')).rowCount, 0);
  assert.equal(await readFile(join(root, key), 'utf8'), 'original');
  assert.equal(await runCleanupOnce(pool, store), 'deleted');
  await assert.rejects(readFile(join(root, key)), { code: 'ENOENT' });
  assert.equal((await pool.query('SELECT * FROM cleanup_jobs WHERE completed_at IS NOT NULL')).rowCount, 1);
});

test('an uncommitted deletion is invisible to the worker and rollback restores it', async (t) => {
  const { pool, store, root, create } = await fixture(t);
  const key = await create();
  const deleting = await pool.connect();
  try {
    await deleting.query('BEGIN');
    await deleting.query('DELETE FROM objects WHERE key = $1', [key]);
    assert.equal(await runCleanupOnce(pool, store), 'idle');
    await deleting.query('ROLLBACK');
  } finally { deleting.release(); }
  assert.equal(await readFile(join(root, key), 'utf8'), 'original');
  assert.equal((await pool.query('SELECT * FROM cleanup_jobs')).rowCount, 0);
  assert.equal((await pool.query('SELECT retired FROM object_keys WHERE key = $1', [key])).rows[0].retired, false);
});
