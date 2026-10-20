import scratchHome from '../../helpers/scratch-home.cjs';
scratchHome.refuseEntry(import.meta.url);

export async function cleanupAfterTest(activeTestError, cleanups, label) {
  const errors = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) return;

  const cleanupError = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, `${label} cleanup failed`);
  if (activeTestError !== undefined) {
    process.stderr.write(`${label}: cleanup failed while preserving the test failure: ${cleanupError.stack || cleanupError}\n`);
    return;
  }
  throw cleanupError;
}
