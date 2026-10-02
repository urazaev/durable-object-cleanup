import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FileObjectStore, ObjectDeleter } from './file-store.js';

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await work(client);
    await client.query('COMMIT'); // Do not return a claim until COMMIT is acknowledged.
    return result;
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(failed); }
}

export async function createObject(
  pool: Pool, store: FileObjectStore, label: string, bytes: Uint8Array,
): Promise<string> {
  const key = randomUUID();
  // Allocation commits separately: even a failed upload must never reuse its key.
  await pool.query('INSERT INTO object_keys(key) VALUES ($1)', [key]);
  await store.writeNew(key, bytes);
  await pool.query('INSERT INTO objects(key, label) VALUES ($1, $2)', [key, label]);
  return key;
}

export async function queueDeletion(pool: Pool, key: string): Promise<boolean> {
  return transaction(pool, async (client) => {
    // Acquire the same per-generation lock as reference writers, in the same order.
    await client.query('SELECT key FROM object_keys WHERE key = $1 FOR UPDATE', [key]);
    const removed = await client.query('DELETE FROM objects WHERE key = $1', [key]);
    // The DB trigger creates the manifest and retires the key in this transaction.
    return removed.rowCount === 1;
  });
}

interface Claim { object_key: string; lease_token: string }
export interface WorkerOptions { leaseMs?: number; retryMs?: number }
export type CleanupResult = 'idle' | 'deleted' | 'retry' | 'stale';

async function claimNext(pool: Pool, leaseMs: number): Promise<Claim | undefined> {
  return transaction(pool, async (client) => {
    const result = await client.query<Claim>(`
      WITH candidate AS (
        SELECT object_key FROM cleanup_jobs
        WHERE completed_at IS NULL AND available_at <= clock_timestamp()
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        ORDER BY available_at, object_key FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE cleanup_jobs AS job SET lease_token = $1,
        lease_until = clock_timestamp() + $2 * interval '1 millisecond',
        attempts = attempts + 1
      FROM candidate WHERE job.object_key = candidate.object_key
      RETURNING job.object_key, job.lease_token`, [randomUUID(), leaseMs]);
    return result.rows[0];
  });
}

export async function runCleanupOnce(
  pool: Pool, store: ObjectDeleter, options: WorkerOptions = {},
): Promise<CleanupResult> {
  const { leaseMs = 30_000, retryMs = 1_000 } = options;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 ||
      !Number.isSafeInteger(retryMs) || retryMs < 0) throw new Error('Invalid worker timing');
  const claim = await claimNext(pool, leaseMs);
  if (!claim) return 'idle';

  // This boundary is deliberately outside every database transaction.
  try { await store.delete(claim.object_key); }
  catch (error) {
    const result = await pool.query(`
      UPDATE cleanup_jobs SET lease_token = NULL, lease_until = NULL,
        available_at = clock_timestamp() + $3 * interval '1 millisecond', last_error = $4
      WHERE object_key = $1 AND lease_token = $2 AND completed_at IS NULL`,
    [claim.object_key, claim.lease_token, retryMs, String(error).slice(0, 300)]);
    return result.rowCount === 1 ? 'retry' : 'stale';
  }

  // A lost acknowledgement leaves an expired lease for a later idempotent retry.
  const result = await pool.query(`
    UPDATE cleanup_jobs SET completed_at = clock_timestamp(), lease_token = NULL,
      lease_until = NULL, last_error = NULL
    WHERE object_key = $1 AND lease_token = $2 AND completed_at IS NULL`,
  [claim.object_key, claim.lease_token]);
  return result.rowCount === 1 ? 'deleted' : 'stale';
}
