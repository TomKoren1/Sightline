/**
 * Bounded-concurrency task runner.
 *
 * A scan of a real account fans out across every service in every region. Run
 * unbounded, that is a few hundred simultaneous AWS calls and a guaranteed
 * throttle; run serially, it takes minutes. This keeps a fixed number in
 * flight.
 *
 * Every task is expected to resolve - failures are captured by the caller as
 * unit outcomes rather than thrown - so there is no rejection handling here.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
