import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { FileObjectStore } from '../src/file-store.js';
import { createObject, queueDeletion, runCleanupOnce } from '../src/cleanup.js';
import { disposableDatabaseURL } from '../src/disposable-database.js';

const databaseURL = disposableDatabaseURL(process.env.TEST_DATABASE_URL);

async function fixture(t: TestContext) {
  const schema = `cleanup_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseURL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseURL,
    application_name: schema,
    options: `-c search_path=${schema} -c statement_timeout=5000`,
    max: 6,
  });
  const root = await mkdtemp(join(tmpdir(), 'cleanup-integration-'));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });
  await pool.query(
    await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'),
  );
  const store = await FileObjectStore.open(root);
  const create = () =>
    createObject(pool, store, 'example', Buffer.from('original'));
  return { pool, root, store, create, schema };
}

test('references prevent deletion; a committed delete leaves a durable job', async (t) => {
  const { pool, store, root, create } = await fixture(t);
  const key = await create();
  await pool.query(
    'INSERT INTO object_references(id, object_key) VALUES ($1, $2)',
    [randomUUID(), key],
  );
  await assert.rejects(queueDeletion(pool, key), /referenced|foreign key/i);
  assert.equal((await pool.query('SELECT * FROM cleanup_jobs')).rowCount, 0);
  await pool.query('DELETE FROM object_references');
  assert.equal(await queueDeletion(pool, key), true);
  assert.equal((await pool.query('SELECT * FROM objects')).rowCount, 0);
  assert.equal(await readFile(join(root, key), 'utf8'), 'original');
  assert.equal(await runCleanupOnce(pool, store), 'deleted');
  await assert.rejects(readFile(join(root, key)), { code: 'ENOENT' });
  assert.equal(
    (
      await pool.query(
        'SELECT * FROM cleanup_jobs WHERE completed_at IS NOT NULL',
      )
    ).rowCount,
    1,
  );
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
  } finally {
    deleting.release();
  }
  assert.equal(await readFile(join(root, key), 'utf8'), 'original');
  assert.equal((await pool.query('SELECT * FROM cleanup_jobs')).rowCount, 0);
  assert.equal(
    (await pool.query('SELECT retired FROM object_keys WHERE key = $1', [key]))
      .rows[0].retired,
    false,
  );
});

async function waitForBlockedQuery(
  pool: Pool,
  application: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query(
      `SELECT pid FROM pg_stat_activity
      WHERE application_name = $1 AND wait_event_type = 'Lock'`,
      [application],
    );
    if (waiting.rowCount) return;
    await delay(10);
  }
  throw new Error(
    'Expected another real PostgreSQL connection to wait for a row lock',
  );
}

test('a concurrent reference writer wins first; deletion waits and then refuses', async (t) => {
  const { pool, create, schema } = await fixture(t);
  const key = await create();
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('INSERT INTO object_references VALUES ($1, $2)', [
      randomUUID(),
      key,
    ]);
    const deletion = assert.rejects(
      queueDeletion(pool, key),
      /referenced|foreign key/i,
    );
    await waitForBlockedQuery(pool, schema);
    await writer.query('COMMIT');
    await deletion;
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  assert.equal((await pool.query('SELECT * FROM cleanup_jobs')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM objects')).rowCount, 1);
});

test('retirement wins first; a waiting reference writer cannot resurrect the object', async (t) => {
  const { pool, create, schema } = await fixture(t);
  const key = await create();
  const deleting = await pool.connect();
  try {
    await deleting.query('BEGIN');
    await deleting.query(
      'SELECT key FROM object_keys WHERE key = $1 FOR UPDATE',
      [key],
    );
    await deleting.query('DELETE FROM objects WHERE key = $1', [key]);
    const reference = assert.rejects(
      pool.query('INSERT INTO object_references VALUES ($1, $2)', [
        randomUUID(),
        key,
      ]),
      /retired/,
    );
    await waitForBlockedQuery(pool, schema);
    await deleting.query('COMMIT');
    await reference;
  } finally {
    await deleting.query('ROLLBACK');
    deleting.release();
  }
  assert.equal(
    (await pool.query('SELECT * FROM object_references')).rowCount,
    0,
  );
});

test('retired keys cannot be reused through inserts, updates or reference reassignment', async (t) => {
  const { pool, store, create } = await fixture(t);
  const oldKey = await create();
  await queueDeletion(pool, oldKey);
  await runCleanupOnce(pool, store);
  const newKey = await create();
  assert.notEqual(newKey, oldKey);
  await assert.rejects(
    pool.query('INSERT INTO object_keys(key) VALUES ($1)', [oldKey]),
    /duplicate/,
  );
  await assert.rejects(
    pool.query('DELETE FROM object_keys WHERE key = $1', [oldKey]),
    /permanent/,
  );
  await assert.rejects(
    pool.query('UPDATE object_keys SET retired = false WHERE key = $1', [
      oldKey,
    ]),
    /irreversible/,
  );
  await assert.rejects(
    pool.query('INSERT INTO objects VALUES ($1, $2)', [oldKey, 'reused']),
    /retired/,
  );
  await assert.rejects(
    pool.query('UPDATE objects SET key = $1 WHERE key = $2', [oldKey, newKey]),
    /immutable/,
  );
  const reference = randomUUID();
  await pool.query('INSERT INTO object_references VALUES ($1, $2)', [
    reference,
    newKey,
  ]);
  await assert.rejects(
    pool.query('UPDATE object_references SET object_key = $1 WHERE id = $2', [
      oldKey,
      reference,
    ]),
    /retired/,
  );
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('concurrent workers claim different committed jobs', async (t) => {
  const { pool, store, create } = await fixture(t);
  const keys = [await create(), await create()];
  for (const key of keys) await queueDeletion(pool, key);
  const proceed = gate();
  const entered = gate();
  const seen: string[] = [];
  const slowStore = {
    async delete(key: string) {
      seen.push(key);
      // A second connection observes the claim, proving COMMIT precedes deletion.
      const job = await pool.query(
        'SELECT lease_token FROM cleanup_jobs WHERE object_key = $1',
        [key],
      );
      assert.ok(job.rows[0].lease_token);
      if (seen.length === 2) entered.release();
      await proceed.promise;
      await store.delete(key);
    },
  };
  const first = runCleanupOnce(pool, slowStore);
  const second = runCleanupOnce(pool, slowStore);
  try {
    await Promise.race([
      entered.promise,
      delay(3_000).then(() => {
        throw new Error('Workers did not progress');
      }),
    ]);
    assert.deepEqual(new Set(seen), new Set(keys));
  } finally {
    proceed.release();
  }
  assert.deepEqual(await Promise.all([first, second]), ['deleted', 'deleted']);
});

test('one failed object does not prevent another job from finishing', async (t) => {
  const { pool, store, create } = await fixture(t);
  for (const key of [await create(), await create()])
    await queueDeletion(pool, key);
  let failFirst = true;
  const flakyStore = {
    async delete(key: string) {
      if (failFirst) {
        failFirst = false;
        throw new Error('Temporary filesystem failure');
      }
      await store.delete(key);
    },
  };
  assert.equal(
    await runCleanupOnce(pool, flakyStore, { retryMs: 60_000 }),
    'retry',
  );
  assert.equal(await runCleanupOnce(pool, flakyStore), 'deleted');
  assert.equal(
    (await pool.query('SELECT * FROM cleanup_jobs WHERE completed_at IS NULL'))
      .rowCount,
    1,
  );
  await pool.query(
    "UPDATE cleanup_jobs SET available_at = now() - interval '1 second'",
  );
  assert.equal(await runCleanupOnce(pool, store), 'deleted');
  const attempts = await pool.query(
    'SELECT attempts FROM cleanup_jobs ORDER BY attempts',
  );
  assert.deepEqual(
    attempts.rows.map((row) => row.attempts),
    [1, 2],
  );
});

for (const oldWorkerFails of [false, true]) {
  test(`expired worker ${oldWorkerFails ? 'failure' : 'success'} cannot overwrite the new claim`, async (t) => {
    const { pool, store, root, create } = await fixture(t);
    const key = await create();
    await queueDeletion(pool, key);
    const entered = gate();
    const proceed = gate();
    const oldWorker = runCleanupOnce(pool, {
      async delete(oldKey) {
        entered.release();
        await proceed.promise;
        if (oldWorkerFails) throw new Error('Late error');
        await store.delete(oldKey);
      },
    });
    await entered.promise;
    let replacement: string;
    try {
      await pool.query(
        "UPDATE cleanup_jobs SET lease_until = now() - interval '1 second'",
      );
      assert.equal(await runCleanupOnce(pool, store), 'deleted');
      replacement = await create();
    } finally {
      proceed.release();
    }
    assert.equal(await oldWorker, 'stale');
    const result = (await pool.query('SELECT * FROM cleanup_jobs')).rows[0];
    assert.ok(result.completed_at);
    assert.equal(result.last_error, null);
    assert.equal(result.attempts, 2);
    assert.notEqual(replacement!, key);
    assert.equal(await readFile(join(root, replacement!), 'utf8'), 'original');
  });
}

async function crashWorker(
  mode: string,
  key: string,
  root: string,
  schema: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./crash-worker.ts', import.meta.url)),
      mode,
      key,
      root,
      schema,
    ],
    {
      env: { ...process.env, TEST_DATABASE_URL: databaseURL },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const outcome = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(outcome.signal, 'SIGKILL', stderr);
}

test('process death after COMMIT leaves a recoverable durable job', async (t) => {
  const { pool, store, root, create, schema } = await fixture(t);
  const key = await create();
  await crashWorker('after-commit', key, root, schema);
  assert.equal((await pool.query('SELECT * FROM objects')).rowCount, 0);
  assert.equal(await readFile(join(root, key), 'utf8'), 'original');
  assert.equal(await runCleanupOnce(pool, store), 'deleted');
});

test('process death after unlink and before acknowledgement retries safely', async (t) => {
  const { pool, store, root, create, schema } = await fixture(t);
  const key = await create();
  await queueDeletion(pool, key);
  await crashWorker('after-unlink', key, root, schema);
  await assert.rejects(readFile(join(root, key)), { code: 'ENOENT' });
  assert.equal(
    (await pool.query('SELECT completed_at FROM cleanup_jobs')).rows[0]
      .completed_at,
    null,
  );
  await pool.query(
    "UPDATE cleanup_jobs SET lease_until = now() - interval '1 second'",
  );
  assert.equal(await runCleanupOnce(pool, store), 'deleted');
  assert.equal(
    (await pool.query('SELECT attempts FROM cleanup_jobs')).rows[0].attempts,
    2,
  );
});
