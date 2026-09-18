/**
 * Sequential upload queue.
 *
 * Files are transferred one at a time, in the order the user picked them:
 * progress stays readable, the server sees one multipart request at a time, and
 * the first file is visible as "done" before the next one starts.
 *
 * A failure halts the queue. The failed item is handed back to the caller (the
 * view marks its chip as failed and offers a retry); nothing behind it starts
 * until the user retries that file or drops it. Ids that uploaded successfully
 * are remembered, so no file is ever transferred twice.
 *
 * The queue owns ordering only — state lives with the caller, which is why this
 * module has no framework dependency.
 */

export interface UploadQueueItem {
  id: string;
}

export interface UploadQueue<T extends UploadQueueItem> {
  /** Appends items in pick order and starts draining when idle. */
  enqueue(items: T[]): void;
  /** Sends a failed item again, at the front, and resumes the queue. */
  retry(item: T): void;
  /** Forgets an item (its chip was removed) and resumes if it was the blocker. */
  drop(id: string): void;
  /** Forgets everything (queued and completed ids) — the caller cleared its list. */
  reset(): void;
  /** Items still waiting for their turn, excluding the one uploading. */
  readonly waiting: number;
  /** True while an upload is in flight. */
  readonly running: boolean;
}

/**
 * @param upload Transfers one item. Rejecting means "this file failed" and
 *   stops the queue; it must settle (never hang) or the queue stalls.
 */
export function createUploadQueue<T extends UploadQueueItem>(
  upload: (item: T) => Promise<void>,
): UploadQueue<T> {
  const queue: T[] = [];
  /** Ids that already uploaded successfully — a file is never sent twice. */
  const done = new Set<string>();
  let running = false;

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const item = queue[0];
        try {
          await upload(item);
        } catch {
          // Hand the failed item back so a retry can put it at the front.
          if (queue[0] === item) queue.shift();
          return;
        }
        // `drop()` may have removed it while it uploaded.
        if (queue[0] === item) queue.shift();
        done.add(item.id);
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(items) {
      // Never queue the same file twice (a re-pick of a sent file is ignored).
      const fresh = items.filter(
        (item) => !done.has(item.id) && !queue.some((queued) => queued.id === item.id),
      );
      if (fresh.length === 0) return;
      queue.push(...fresh);
      void drain();
    },
    retry(item) {
      // A double click on retry is a no-op, and an uploaded file is never sent
      // again — only a failed (still-unsent) item can be retried.
      if (done.has(item.id) || queue.some((queued) => queued.id === item.id)) return;
      queue.unshift(item);
      void drain();
    },
    drop(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
      void drain();
    },
    reset() {
      queue.length = 0;
      done.clear();
    },
    get waiting() {
      return queue.length;
    },
    get running() {
      return running;
    },
  };
}
