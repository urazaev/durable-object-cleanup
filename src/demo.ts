import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createObject, queueDeletion, runCleanupOnce } from './cleanup.js';
import { disposableDatabaseURL } from './disposable-database.js';
import { FileObjectStore } from './file-store.js';

const connectionString = disposableDatabaseURL(process.env.TEST_DATABASE_URL);
const schema = `cleanup_demo_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
});
const root = await mkdtemp(join(tmpdir(), 'cleanup-demo-'));
let schemaCreated = false;

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await pool.query(
    await readFile(new URL('./schema.sql', import.meta.url), 'utf8'),
  );
  const store = await FileObjectStore.open(root);
  const key = await createObject(
    pool,
    store,
    'Example attachment',
    Buffer.from('hello'),
  );
  const reference = randomUUID();
  await pool.query('INSERT INTO object_references VALUES ($1, $2)', [
    reference,
    key,
  ]);
  try {
    await queueDeletion(pool, key);
  } catch (error) {
    if ((error as { code?: string }).code !== '23503') {
      throw error;
    }
    console.log('1. Reference exists: deletion rejected; file retained.');
  }
  await pool.query('DELETE FROM object_references WHERE id = $1', [reference]);
  await queueDeletion(pool, key);
  console.log(
    '2. COMMIT acknowledged: catalog removed; durable cleanup job exists.',
  );
  console.log(`3. Worker: ${await runCleanupOnce(pool, store)}.`);
  console.log(`4. Next worker pass: ${await runCleanupOnce(pool, store)}.`);
} finally {
  await pool.end();
  if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
