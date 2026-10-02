import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disposableDatabaseURL } from '../src/disposable-database.js';

test('the harness rejects remote hosts, protocol changes and connection overrides', () => {
  const local = 'postgresql://demo:demo@127.0.0.1:55433/cleanup_test';
  assert.equal(disposableDatabaseURL(local), local);
  for (const url of [
    undefined,
    'https://localhost/test',
    'postgresql://example.com/test',
    `${local}?host=example.com`,
    `${local}?options=-c%20search_path=public`,
    `${local}#ignored`,
  ]) {
    assert.throws(() => disposableDatabaseURL(url));
  }
});
