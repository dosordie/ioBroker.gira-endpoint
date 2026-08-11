const assert = require("assert").strict;
const {
  CO_META_MAX_CONCURRENCY,
  CoMetaRequestQueue,
} = require("../build/lib/coMetaQueue");
const {
  CO_META_STATE_DEFINITIONS,
  getCoMetaFormatText,
  getCoMetaValueType,
} = require("../build/lib/coMeta");

async function main() {
  let active = 0;
  let maximumActive = 0;
  const requested = [];
  const fetched = new Set();
  const queue = new CoMetaRequestQueue(async (key) => {
    requested.push(key);
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return true;
  }, fetched, CO_META_MAX_CONCURRENCY);

  const configuredKeys = Array.from({ length: 12 }, (_, index) => `CO@TEST${index}`);
  await queue.enqueueAll(configuredKeys);
  assert.deepStrictEqual(new Set(requested), new Set(configuredKeys));
  assert.ok(maximumActive <= CO_META_MAX_CONCURRENCY);
  assert.equal(maximumActive, CO_META_MAX_CONCURRENCY);
  assert.deepStrictEqual(fetched, new Set(configuredKeys));

  let attempts = 0;
  const retryFetched = new Set();
  const retryQueue = new CoMetaRequestQueue(async () => {
    attempts++;
    if (attempts === 1) throw new Error("simulated timeout");
    return true;
  }, retryFetched, 1);
  assert.equal(await retryQueue.enqueue("CO@RETRY"), false);
  assert.equal(retryFetched.has("CO@RETRY"), false);
  assert.equal(await retryQueue.enqueue("CO@RETRY"), true);
  assert.equal(retryFetched.has("CO@RETRY"), true);
  assert.equal(attempts, 2);

  // The same path is used for configured and later dynamically discovered COs.
  assert.equal(await retryQueue.enqueue("CO@DYNAMIC"), true);
  assert.equal(retryFetched.has("CO@DYNAMIC"), true);

  assert.deepStrictEqual(CO_META_STATE_DEFINITIONS.map(([suffix]) => suffix), [
    "metaFormatText",
    "metaValueType",
  ]);
  assert.equal(getCoMetaFormatText({ format: 4 }), "16 Bit Gleitkomma");
  assert.equal(getCoMetaValueType({ format: 4 }), "number");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
