/** Serializes deletion against downloads, including writes already in flight. */
export function createOfflineJobCoordinator<Result>(options: {
  canceledResult: () => Result;
  onCancel: (key: string) => void;
}) {
  type Job = { canceled: boolean; promise: Promise<Result> };
  const jobs = new Map<string, Job>();
  const removals = new Map<string, Promise<void>>();
  let clearing: Promise<void> | null = null;

  function run(key: string, task: () => Promise<Result>): Promise<Result> {
    const removal = removals.get(key);
    const existing = jobs.get(key);
    if (existing && !existing.canceled) return existing.promise;
    const job: Job = { canceled: false, promise: Promise.resolve(options.canceledResult()) };
    const barriers = [clearing, removal].filter(Boolean);
    job.promise = Promise.all(barriers).then(() => job.canceled ? options.canceledResult() : task());
    jobs.set(key, job);
    const release = () => { if (jobs.get(key) === job) jobs.delete(key); };
    void job.promise.then(release, release);
    return job.promise;
  }

  function cancel(key: string, job: Job) {
    job.canceled = true;
    options.onCancel(key);
  }

  function remove(key: string, task: () => Promise<void>): Promise<void> {
    const job = jobs.get(key);
    if (job) cancel(key, job);
    const run = Promise.all([clearing, removals.get(key), job?.promise].map((p) => p?.catch(() => undefined)))
      .then(task);
    removals.set(key, run);
    const release = () => { if (removals.get(key) === run) removals.delete(key); };
    void run.then(release, release);
    return run;
  }

  function clear(task: () => Promise<void>): Promise<void> {
    for (const [key, job] of jobs) cancel(key, job);
    const pending = [clearing, ...removals.values(), ...Array.from(jobs.values(), (job) => job.promise)];
    const run = Promise.all(pending.map((p) => p?.catch(() => undefined))).then(task);
    clearing = run;
    const release = () => { if (clearing === run) clearing = null; };
    void run.then(release, release);
    return run;
  }

  return { run, remove, clear };
}
