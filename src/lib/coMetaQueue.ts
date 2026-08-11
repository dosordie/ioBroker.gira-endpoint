export const CO_META_MAX_CONCURRENCY = 4;

/** A small dependency-free queue which de-duplicates active and successful requests. */
export class CoMetaRequestQueue {
  private readonly pending: Array<{
    key: string;
    resolve: (success: boolean) => void;
  }> = [];
  private readonly activeKeys = new Set<string>();
  private activeCount = 0;

  public constructor(
    private readonly request: (key: string) => Promise<boolean>,
    public readonly fetched: Set<string>,
    private readonly maxConcurrency = CO_META_MAX_CONCURRENCY,
    private readonly excluded = new Set<string>()
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("Meta queue concurrency must be a positive integer");
    }
  }

  public enqueue(key: string): Promise<boolean> {
    if (this.excluded.has(key)) return Promise.resolve(false);
    if (this.fetched.has(key)) return Promise.resolve(true);
    if (this.activeKeys.has(key) || this.pending.some((item) => item.key === key)) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      this.pending.push({ key, resolve });
      this.drain();
    });
  }

  public async enqueueAll(keys: Iterable<string>): Promise<void> {
    await Promise.all(Array.from(new Set(keys), (key) => this.enqueue(key)));
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrency && this.pending.length) {
      const item = this.pending.shift()!;
      this.activeCount++;
      this.activeKeys.add(item.key);
      void (async () => {
        let success = false;
        try {
          success = await this.request(item.key);
          if (success) this.fetched.add(item.key);
        } catch {
          success = false;
        } finally {
          this.activeCount--;
          this.activeKeys.delete(item.key);
          this.drain();
          item.resolve(success);
        }
      })();
    }
  }
}
