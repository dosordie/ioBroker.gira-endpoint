import { strict as assert } from "assert";
import { describe, it } from "mocha";
const { encodeUidValue, decodeAckValue } = require("../src/main");

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
});
