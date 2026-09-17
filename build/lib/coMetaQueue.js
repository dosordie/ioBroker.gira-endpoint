"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoMetaRequestQueue = exports.CO_META_MAX_CONCURRENCY = void 0;
exports.CO_META_MAX_CONCURRENCY = 4;
/** A small dependency-free queue which de-duplicates active and successful requests. */
class CoMetaRequestQueue {
    constructor(request, fetched, maxConcurrency = exports.CO_META_MAX_CONCURRENCY, excluded = new Set()) {
        this.request = request;
        this.fetched = fetched;
        this.maxConcurrency = maxConcurrency;
        this.excluded = excluded;
        this.pending = [];
        this.activeKeys = new Set();
        this.activeCount = 0;
        if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
            throw new Error("Meta queue concurrency must be a positive integer");
        }
    }
    enqueue(key) {
        if (this.excluded.has(key))
            return Promise.resolve(false);
        if (this.fetched.has(key))
            return Promise.resolve(true);
        if (this.activeKeys.has(key) || this.pending.some((item) => item.key === key)) {
            return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            this.pending.push({ key, resolve });
            this.drain();
        });
    }
    async enqueueAll(keys) {
        await Promise.all(Array.from(new Set(keys), (key) => this.enqueue(key)));
    }
    drain() {
        while (this.activeCount < this.maxConcurrency && this.pending.length) {
            const item = this.pending.shift();
            this.activeCount++;
            this.activeKeys.add(item.key);
            void (async () => {
                let success = false;
                try {
                    success = await this.request(item.key);
                    if (success)
                        this.fetched.add(item.key);
                }
                catch {
                    success = false;
                }
                finally {
                    this.activeCount--;
                    this.activeKeys.delete(item.key);
                    this.drain();
                    item.resolve(success);
                }
            })();
        }
    }
}
exports.CoMetaRequestQueue = CoMetaRequestQueue;
