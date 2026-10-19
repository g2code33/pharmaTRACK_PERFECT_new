/**
 * Pulls a human-readable message out of whatever a `catch` block received.
 *
 * `error instanceof Error` is NOT a safe test for "does this have a useful
 * message" — browsers commonly reject with a `DOMException` (IndexedDB,
 * crypto, and file-system errors all do this), and `DOMException` is not,
 * in general, `instanceof Error`. Code that only handled the `Error` case
 * was silently discarding the one piece of information that would have
 * explained a real failure (e.g. a wedged local database) and showing a
 * generic placeholder instead, even though the real message was sitting
 * right there on the rejected value.
 */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string' &&
    (error as { message: string }).message
  ) {
    return (error as { message: string }).message;
  }
  if (typeof error === 'string' && error) return error;
  return fallback;
}
