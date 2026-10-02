# Durable object cleanup

[![CI](https://github.com/urazaev/durable-object-cleanup/actions/workflows/check.yml/badge.svg)](https://github.com/urazaev/durable-object-cleanup/actions/workflows/check.yml)

A small TypeScript example of deleting database metadata and external objects without losing cleanup work when a process crashes. PostgreSQL stores the cleanup manifest in the same transaction that deletes the catalog entry. A separate worker removes the file only after its claim transaction commits.

The interesting boundary is between two systems: a database rollback cannot restore an already deleted external object. This example keeps that external deletion on the committed side of the boundary, and makes a repeated delete safe through permanent, nonreused object keys.

## Run locally

Requires Node.js 22+, npm, and PostgreSQL 15+ (or Docker Compose).

```sh
npm ci
docker compose up -d --wait
export TEST_DATABASE_URL='postgresql://cleanup:cleanup@127.0.0.1:55433/cleanup_test'
npm test
npm run check
npm run format:check
npm run demo
docker compose down
```

Compose exposes PostgreSQL only on `127.0.0.1:55433` and uses disposable, memory-backed database storage. The sample credentials are local demo values. With an existing **disposable** PostgreSQL instance, set `TEST_DATABASE_URL` to its loopback URL and omit the Docker commands. `.env.example` is documentation; scripts do not load `.env` automatically.

Each integration test and demo creates its own random schema and temporary filesystem directory, then removes those resources. They do not migrate or truncate pre-existing tables. The harness rejects remote hosts, other protocols, connection-string query parameters and fragments, so URL overrides cannot silently change its host or schema options. Do not use a production database.

The demo shows a reference preventing deletion, then removes that reference, commits the deletion and runs the worker. `npm run test:unit` runs only the filesystem adapter tests without PostgreSQL. The full test command deliberately fails if a database URL is missing.

The GitHub Actions workflow runs on pushes and pull requests with Node.js 22 and a temporary PostgreSQL 15 service. It installs the lockfile, checks types and formatting, runs the full test suite, and exercises the demo.

## Read the implementation

| File                                           | Responsibility                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`src/schema.sql`](src/schema.sql)             | Permanent key registry, live catalog, references, durable cleanup manifest and database guards. |
| [`src/cleanup.ts`](src/cleanup.ts)             | Create a generation, queue deletion, claim work, delete externally and acknowledge.             |
| [`src/file-store.ts`](src/file-store.ts)       | Flat UUID keys, exclusive file creation and idempotent unlink inside a dedicated root.          |
| [`test/cleanup.test.ts`](test/cleanup.test.ts) | Real PostgreSQL races, retries, expired claims and crash recovery.                              |
| [`test/crash-worker.ts`](test/crash-worker.ts) | Child process deliberately killed at two irreversible boundaries.                               |

## Transaction and worker flow

```mermaid
sequenceDiagram
  participant A as Application
  participant DB as PostgreSQL
  participant W as Cleanup worker
  participant FS as Local object store
  A->>DB: BEGIN
  A->>DB: Lock object generation
  A->>DB: DELETE catalog entry
  Note over DB: Trigger retires key and inserts job.<br/>Existing references reject the entire transaction.
  A->>DB: COMMIT
  DB-->>A: Commit acknowledged
  W->>DB: BEGIN
  W->>DB: Claim ready job with SKIP LOCKED
  W->>DB: COMMIT
  DB-->>W: Claim acknowledged
  W->>FS: Delete immutable generation key
  FS-->>W: Deleted or already absent
  W->>DB: Acknowledge only if lease token still matches
```

### 1. Reserve an immutable generation

`createObject` generates a UUID v4 and reserves it in `object_keys` before writing bytes. The registry insert commits separately, so a failed upload does not free that key for reuse. File creation is exclusive; the catalog entry is published only after the write finishes.

Callers cannot choose a key through this creation API. Replacing an attachment means creating a **new generation with a new physical key**, then changing its reference. Never overwrite or reuse an old physical key. `FileObjectStore.writeNew` is a low-level adapter operation, intended only for `createObject` after allocation, not an independent attachment-write API.

### 2. Delete the catalog entry and schedule cleanup together

`queueDeletion` locks the registry row before deleting its catalog entry. The database trigger retires the key and creates a cleanup job in that same transaction. A restrictive foreign key rejects deletion if any reference remains; the deletion, tombstone and manifest all roll back together.

Reference inserts and reassignment lock the same generation and reject retired keys. If a writer wins first, deletion waits and then finds the reference. If retirement wins first, the writer waits and then rejects the retired generation. The lock is per generation, not a coarse global advisory lock.

Database guards also reject resetting retirement, deleting registry rows, changing a catalog key or recreating a retired catalog entry. **The permanent registry is part of correctness**, not optional audit data. Removing it would remove the key-reuse barrier.

### 3. Claim, delete, acknowledge

Workers use `FOR UPDATE SKIP LOCKED` to claim one ready job. A fresh token identifies each lease. The worker waits for `COMMIT` to return before invoking the object adapter. It holds no transaction open during external I/O.

On an adapter error, the current owner schedules a delayed retry; other jobs remain available. If the process dies, the lease eventually expires. If deletion succeeded but acknowledgement did not, the retry sees an absent file and completes normally.

Both success and failure updates require the current lease token. An expired worker can still finish an external request, but cannot acknowledge or reschedule a newer claim. Its late deletion targets only the old, permanently retired generation; a replacement uses a different key.

## Guarantees and deliberate limits

- A rolled-back catalog deletion cannot leave a cleanup manifest. Workers cannot see an uncommitted job.
- External deletion starts only after an acknowledged claim commit. An uncertain commit result aborts that worker attempt; a committed but unacknowledged lease can later expire and be retried.
- Concurrent workers can make duplicate external attempts after lease expiry. This is **at-least-once cleanup**, not exactly-once external side effects. Safety requires an idempotent, generation-specific delete adapter.
- References cannot target a retired or deleted generation through the guarded database operations. Registry rows are never reused or garbage-collected by this example.
- A running worker and an available database/filesystem are required for progress. Retries are fixed-delay; there is no scheduler daemon, lease heartbeat, exponential backoff, dead-letter queue or operational dashboard.
- Upload recovery is outside scope. Failure after key reservation or file creation can leave an allocated key or an orphan file without a catalog entry. The example intentionally does not release or reuse that key. A complete upload workflow needs its own durable state machine and reconciliation.
- The filesystem root must be dedicated and owned by the application, not writable by a hostile process. Flat UUID keys reject traversal; exclusive writes reject overwrite/symlink targets; unlink never follows a final-component symlink. `lstat` plus `unlink` does not defend against an attacker replacing the root or its ancestors between operations.
- Database administrators can bypass triggers or modify the schema. Application roles must not truncate the key registry, alter guards, forge manifests or bypass the supported write protocol. Direct SQL deletion still runs the guards, but may deadlock/abort against writers because `DELETE` locks the catalog before its trigger locks the registry. The public helper acquires the registry lock first. Multi-object transactions also need consistent lock ordering and transaction retry.
- Tests cover **process crashes**, not sudden power loss, disk corruption, distributed storage consistency or PostgreSQL failover. No cloud account, production service or customer data is used.

## Evidence in the tests

The suite uses real PostgreSQL connections and observes database lock waits rather than assuming a race happened after an arbitrary sleep. Child processes receive `SIGKILL` after the catalog commit and after unlink but before acknowledgement. Tests also cover rollback visibility, partial adapter failures, concurrent claims, stale success/error updates, reference reassignment and nonreused keys. Lease expiry is advanced explicitly in the test schema to avoid slow timing-dependent tests.

The transaction uses one checked-out client throughout, as required by [node-postgres](https://node-postgres.com/features/transactions). PostgreSQL documents [`SKIP LOCKED` for queue consumers](https://www.postgresql.org/docs/15/sql-select.html) and [row-lock behavior](https://www.postgresql.org/docs/15/explicit-locking.html). The locking and retry guarantees above are specific to this example's protocol, not a general distributed transaction implementation.
