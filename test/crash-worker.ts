import { Pool } from 'pg';
import { FileObjectStore } from '../src/file-store.js';
import { queueDeletion, runCleanupOnce } from '../src/cleanup.js';

const [mode, key, root, schema] = process.argv.slice(2);
if (!key || !root || !schema || !/^cleanup_test_[a-f0-9]+$/.test(schema))
  throw new Error('Invalid test fixture');
const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: `-c search_path=${schema}`,
});
const store = await FileObjectStore.open(root);
if (mode === 'after-commit') {
  await queueDeletion(pool, key);
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'after-unlink') {
  await runCleanupOnce(pool, {
    async delete(objectKey) {
      await store.delete(objectKey);
      process.kill(process.pid, 'SIGKILL');
    },
  });
} else throw new Error('Unknown crash boundary');
