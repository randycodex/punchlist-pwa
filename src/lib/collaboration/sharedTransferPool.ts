import { localAccountKey } from '@/lib/localAccount';

export type TransferPoolLimits = {
  maxFiles: number;
  maxBytes: number;
};

export const DEFAULT_DOWNLOAD_POOL_LIMITS: TransferPoolLimits = {
  maxFiles: 6,
  maxBytes: 12 * 1024 * 1024,
};

export const DEFAULT_UPLOAD_POOL_LIMITS: TransferPoolLimits = {
  maxFiles: 4,
  maxBytes: 16 * 1024 * 1024,
};

type QueueEntry<T> = {
  key: string;
  sizeBytes: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export type TransferPoolSnapshot = {
  activeFiles: number;
  activeBytes: number;
  queued: number;
  inflightKeys: number;
  peakActiveFiles: number;
  peakActiveBytes: number;
  started: number;
  completed: number;
  failed: number;
  deduped: number;
};

/** Bounded file/byte pool with in-flight dedupe for immutable attachment transfers. */
export class SharedTransferPool {
  private readonly queue: Array<QueueEntry<unknown>> = [];
  private readonly inflight = new Map<string, Promise<unknown>>();
  private activeFiles = 0;
  private activeBytes = 0;
  private peakActiveFiles = 0;
  private peakActiveBytes = 0;
  private started = 0;
  private completed = 0;
  private failed = 0;
  private deduped = 0;
  private pumping = false;

  constructor(private limits: TransferPoolLimits) {}

  getLimits() {
    return { ...this.limits };
  }

  setLimits(limits: TransferPoolLimits) {
    this.limits = {
      maxFiles: Math.max(1, limits.maxFiles),
      maxBytes: Math.max(1, limits.maxBytes),
    };
    this.pump();
  }

  snapshot(): TransferPoolSnapshot {
    return {
      activeFiles: this.activeFiles,
      activeBytes: this.activeBytes,
      queued: this.queue.length,
      inflightKeys: this.inflight.size,
      peakActiveFiles: this.peakActiveFiles,
      peakActiveBytes: this.peakActiveBytes,
      started: this.started,
      completed: this.completed,
      failed: this.failed,
      deduped: this.deduped,
    };
  }

  resetStats() {
    this.peakActiveFiles = this.activeFiles;
    this.peakActiveBytes = this.activeBytes;
    this.started = 0;
    this.completed = 0;
    this.failed = 0;
    this.deduped = 0;
  }

  /** Schedule work. Identical keys share one in-flight promise. */
  schedule<T>(key: string, sizeBytes: number, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.deduped += 1;
      return existing as Promise<T>;
    }

    let settle!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.inflight.set(key, promise);
    this.queue.push({
      key,
      sizeBytes: Math.max(0, sizeBytes),
      run: run as () => Promise<unknown>,
      resolve: settle as (value: unknown) => void,
      reject: fail,
    });
    this.pump();
    return promise.finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
  }

  /** Wait until queued and active work for this pool is idle. */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.activeFiles > 0 || this.pumping) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private canStart(sizeBytes: number) {
    if (this.activeFiles >= this.limits.maxFiles) return false;
    if (this.activeFiles > 0 && this.activeBytes + sizeBytes > this.limits.maxBytes) return false;
    // Always allow at least one transfer, even when a single object exceeds the byte budget.
    if (this.activeFiles === 0) return true;
    return this.activeBytes + sizeBytes <= this.limits.maxBytes;
  }

  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (!this.canStart(next.sizeBytes)) break;
        this.queue.shift();
        this.activeFiles += 1;
        this.activeBytes += next.sizeBytes;
        this.peakActiveFiles = Math.max(this.peakActiveFiles, this.activeFiles);
        this.peakActiveBytes = Math.max(this.peakActiveBytes, this.activeBytes);
        this.started += 1;
        void next.run().then(
          (value) => {
            this.completed += 1;
            next.resolve(value);
          },
          (error) => {
            this.failed += 1;
            next.reject(error);
          }
        ).finally(() => {
          this.activeFiles -= 1;
          this.activeBytes -= next.sizeBytes;
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}

const downloadPools = new Map<string, SharedTransferPool>();
const uploadPools = new Map<string, SharedTransferPool>();

function poolFor(map: Map<string, SharedTransferPool>, base: string, defaults: TransferPoolLimits) {
  const key = localAccountKey(base);
  let pool = map.get(key);
  if (!pool) {
    pool = new SharedTransferPool(defaults);
    map.set(key, pool);
  }
  return pool;
}

export function getSharedDownloadPool() {
  return poolFor(downloadPools, 'shared-download-pool', DEFAULT_DOWNLOAD_POOL_LIMITS);
}

export function getSharedUploadPool() {
  return poolFor(uploadPools, 'shared-upload-pool', DEFAULT_UPLOAD_POOL_LIMITS);
}

export function resetSharedTransferPoolsForTests() {
  downloadPools.clear();
  uploadPools.clear();
}

export function assetTransferKey(bucket: string, path: string) {
  return `${bucket}:${path}`;
}
