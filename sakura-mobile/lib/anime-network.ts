/** Bound the whole operation, including response bodies and proxies that ignore abort. */
export async function withAnimeTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 6000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Anime request timed out. Please try again.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
