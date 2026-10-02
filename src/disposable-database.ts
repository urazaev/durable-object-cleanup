/** Guard the local demo/test harness, not a general production connection parser. */
export function disposableDatabaseURL(value: string | undefined): string {
  if (!value) {
    throw new Error(
      'Set TEST_DATABASE_URL to a disposable local PostgreSQL database',
    );
  }
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    url.pathname.length < 2
  ) {
    throw new Error(
      'Use a loopback PostgreSQL URL with a database name and no query or fragment',
    );
  }
  return value;
}
