import { strict as assert } from "assert";
import { describe, it } from "mocha";
const { encodeUidValue, decodeAckValue, decodeCoValue } = require("../src/main");

describe("value conversion helpers", () => {
  describe("encodeUidValue", () => {
    it("encodes boolean true in bool mode", () => {
      const res = encodeUidValue(true, true);
      assert.deepStrictEqual(res, { uidValue: "1", ackVal: true, method: "set" });
    });

    it("encodes toggle string", () => {
      const res = encodeUidValue("toggle", true);
      assert.strictEqual(res.uidValue, "1");
      assert.strictEqual(res.method, "toggle");
    });

    it("encodes text in non-bool mode", () => {
      const res = encodeUidValue("abc", false);
      assert.strictEqual(res.uidValue, Buffer.from("abc", "utf8").toString("base64"));
      assert.strictEqual(res.ackVal, "abc");
    });

    it("encodes non-numeric text as UTF-8 by default", () => {
      const res = encodeUidValue("Hauptwäsche", false, "utf8");
      assert.strictEqual(res.uidValue, "SGF1cHR3w6RzY2hl");
      assert.strictEqual(res.ackVal, "Hauptwäsche");
    });

    it("encodes non-numeric text as Latin1 when configured", () => {
      const res = encodeUidValue("Hauptwäsche", false, "latin1");
      assert.strictEqual(res.uidValue, "SGF1cHR35HNjaGU=");
      assert.strictEqual(res.ackVal, "Hauptwäsche");
    });

    it("does not apply text encoding to numbers, booleans, or numeric strings", () => {
      assert.strictEqual(encodeUidValue(1, false, "latin1").uidValue, "1");
      assert.strictEqual(encodeUidValue(true, false, "latin1").uidValue, "1");
      assert.strictEqual(encodeUidValue("123", false, "latin1").uidValue, "123");
    });
  });

  describe("decodeAckValue", () => {
    it("decodes number in bool mode", () => {
      const res = decodeAckValue(1, true);
      assert.deepStrictEqual(res, { value: true, type: "boolean" });
    });

    it("decodes boolean in number mode", () => {
      const res = decodeAckValue(true, false);
      assert.deepStrictEqual(res, { value: 1, type: "number" });
    });
  });

  describe("decodeCoValue", () => {
    it("decodes incoming Latin1 Base64 text with configured Latin1 encoding", () => {
      const res = decodeCoValue("SGF1cHR35HNjaGUy", false, "latin1");
      assert.deepStrictEqual(res, { value: "Hauptwäsche2", type: "string" });
    });

    it("decodes incoming UTF-8 Base64 text with default UTF-8 encoding", () => {
      const res = decodeCoValue("SGF1cHR3w6RzY2hlMg==", false, "utf8");
      assert.deepStrictEqual(res, { value: "Hauptwäsche2", type: "string" });
    });

    it("preserves numeric conversion for incoming numeric strings", () => {
      const res = decodeCoValue("123", false, "latin1");
      assert.deepStrictEqual(res, { value: 123, type: "number" });
    });
  });
});
