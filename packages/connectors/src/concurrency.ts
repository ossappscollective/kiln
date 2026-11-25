/** Run `job` over `items`, at most `limit` at the same time, results in order. The first failure stops starting new work and is thrown. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  job: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure) {
      const mine = index++;
      if (mine >= items.length) return;
      try {
        results[mine] = await job(items[mine] as T);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure.error;
  return results;
}
