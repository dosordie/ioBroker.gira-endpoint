const assert = require("assert").strict;
const { encodeUidValue, decodeCoValue } = require("../build/lib/valueConversion");

// Cover critical text encoding conversions in the test entrypoint run by npm test.
assert.equal(
  encodeUidValue("Hauptwäsche", false, "utf8").uidValue,
  "SGF1cHR3w6RzY2hl"
);
assert.equal(
  encodeUidValue("Hauptwäsche", false, "latin1").uidValue,
  "SGF1cHR35HNjaGU="
);

assert.equal(
  decodeCoValue("SGF1cHR35HNjaGUy", false, "latin1").value,
  "Hauptwäsche2"
);
assert.equal(
  decodeCoValue("SGF1cHR3w6RzY2hlMg==", false, "utf8").value,
  "Hauptwäsche2"
);
assert.deepStrictEqual(decodeCoValue("123", false, "latin1"), {
  value: 123,
  type: "number",
});

const path = require("path");
const { tests } = require("@iobroker/testing");

// Run basic integration tests for the adapter
// This will use the default ioBroker testing harness
// and ensure the adapter can be started and stopped.
tests.integration(path.join(__dirname, ".."));
