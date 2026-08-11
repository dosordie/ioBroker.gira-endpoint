const assert = require("assert").strict;
const { encodeUidValue, decodeCoValue } = require("../build/lib/valueConversion");
const { GIRA_CO_FORMATS, getCoMetaFormatText, getCoMetaValueType } = require("../build/lib/coMeta");
const { parseAdapterConfig, isCommunicationObjectKey } = require("../build/lib/configParser");
const { normalizeArchiveQuery, isExecutableArchiveQuery, buildLastArchiveQuery, formatArchiveStartAt } = require("../build/lib/archiveQuery");
const { makeMinimalRequest, makeRequestKey, makeRequestKeys } = require("../build/lib/requestMatching");
const { buildMessageArchiveWriteRequest, buildSubscriptionKeys, extractMessageArchiveTokens, getLastMessageArchiveState, getMessageArchiveItems, findNewMessageArchiveItems, getMessageArchiveEntryKey, getLatestMessageArchiveItem, getMessageArchiveSubscriptionKey, isMessageArchiveKey, messageArchiveEntryFingerprint, messageArchiveWriteCreated, sanitizeArchiveId, EXPERIMENTAL_MESSAGE_ARCHIVE_METHODS } = require("../build/lib/messageArchive");


const fullArchiveRequest = {
  key: "DA@ENDPOINT",
  method: "get",
  startat: "2607080701",
  cnt: 50,
  size: 60,
  cols: ["#1"],
};
const minimalArchiveRequest = { key: "DA@ENDPOINT", method: "get" };
const fullArchiveRequestKey = makeRequestKey(fullArchiveRequest);
const minimalArchiveRequestKey = makeRequestKey(minimalArchiveRequest);
assert.deepStrictEqual(makeMinimalRequest(fullArchiveRequest), minimalArchiveRequest);
assert.deepStrictEqual(makeRequestKeys(fullArchiveRequest), [
  fullArchiveRequestKey,
  minimalArchiveRequestKey,
]);

const requestTagMap = new Map();
const tag = "archive-tag";
for (const requestKey of makeRequestKeys(fullArchiveRequest)) requestTagMap.set(requestKey, tag);
assert.equal(requestTagMap.get(fullArchiveRequestKey), tag);
assert.equal(requestTagMap.get(minimalArchiveRequestKey), tag);
assert.equal(requestTagMap.get(makeRequestKey(minimalArchiveRequest)), tag);
for (const requestKey of makeRequestKeys(fullArchiveRequest)) requestTagMap.delete(requestKey);
assert.equal(requestTagMap.has(fullArchiveRequestKey), false);
assert.equal(requestTagMap.has(minimalArchiveRequestKey), false);

const parserHelpers = {
  normalizeKey: (rawKey) => {
    const key = String(rawKey ?? "").trim().replace(/^CO@/i, "").toUpperCase();
    return key ? `CO@${key}` : "";
  },
  normalizeArchiveKey: (rawKey) => {
    const key = String(rawKey ?? "").trim().replace(/^DA@/i, "").toUpperCase();
    return key ? `DA@${key}` : "";
  },
  makeEndpointBaseId: (key) => `CO@.${String(key).replace(/^CO@/i, "")}`,
};

assert.deepStrictEqual(EXPERIMENTAL_MESSAGE_ARCHIVE_METHODS, ["add", "write", "insert", "set", "add_entry", "add_message", "trigger", "call"]);
assert.equal(sanitizeArchiveId("MA@Trockner"), "trockner");
assert.equal(sanitizeArchiveId("DA@Heizung"), "heizung");
assert.deepStrictEqual(extractMessageArchiveTokens({ tokens: ["TEST", { token: "INFO" }], nested: { token: "WARN" } }), ["TEST", "INFO", "WARN"]);
assert.deepStrictEqual(extractMessageArchiveTokens({ tokens: { SAFE: "Safe message", ALARM: "Alarm" } }), ["SAFE", "ALARM"]);
const maBefore = { data: { items: [{ ts: 1, token: "TEST", text: "old" }] } };
const maAfter = { data: { items: [{ ts: 2, token: "TEST", text: "new" }, { ts: 1, token: "TEST", text: "old" }] } };
assert.deepStrictEqual(getMessageArchiveItems(maAfter), maAfter.data.items);
assert.deepStrictEqual(findNewMessageArchiveItems(maBefore, maAfter), [maAfter.data.items[0]]);
assert.equal(messageArchiveWriteCreated(maBefore, maAfter, "TEST"), true);
assert.deepStrictEqual(buildMessageArchiveWriteRequest("MA@Trockner", "add", "State_finisch"), {
  type: "call", param: { key: "MA@Trockner", method: "add", token: "State_finisch" },
});
assert.equal("text" in buildMessageArchiveWriteRequest("MA@Trockner", "add", "State_finisch").param, false);
assert.equal(getMessageArchiveSubscriptionKey({ request: { param: { keys: ["MA@Trockner"] } }, data: { items: [{ key: "State_finisch" }] } }, ["MA@Trockner"]), "MA@Trockner");
const realMaItem = { key: "State_finisch", text: "Trocknen fertig", ts: 1786448765.923075 };
const documentedMaItem = { token: "State_finisch", text: "Trocknen fertig", ts: 1786448765.923075 };
assert.equal(getMessageArchiveEntryKey(realMaItem), "State_finisch");
assert.equal(getMessageArchiveEntryKey(documentedMaItem), "State_finisch");
assert.equal(messageArchiveEntryFingerprint(realMaItem), messageArchiveEntryFingerprint(documentedMaItem));
assert.deepStrictEqual(findNewMessageArchiveItems({ data: [documentedMaItem] }, { data: [documentedMaItem, { ...realMaItem, ts: realMaItem.ts + 1 }] }), [{ ...realMaItem, ts: realMaItem.ts + 1 }]);
assert.equal(getMessageArchiveEntryKey({ key: "State_finisch" }), "State_finisch");
assert.deepStrictEqual(getLatestMessageArchiveItem([{ ...realMaItem, ts: 1 }, realMaItem, { ...realMaItem, ts: 2 }]), realMaItem);
assert.deepStrictEqual(getLastMessageArchiveState([documentedMaItem, realMaItem]), {
  key: "State_finisch",
  text: "Trocknen fertig",
  ts: 1786448765.923075,
  time: new Date(1786448765.923075 * 1000).toLocaleString(),
});

const parsedConnection = parseAdapterConfig(
  { host: " 1.2.3.4 ", port: "81", ssl: true, authHeader: true },
  parserHelpers
);
assert.equal(parsedConnection.connection.host, "1.2.3.4");
assert.equal(parsedConnection.connection.port, 81);
assert.equal(parsedConnection.connection.ssl, true);
assert.equal(parsedConnection.connection.path, "/endpoints/ws");
assert.equal(parsedConnection.connection.authHeader, true);

const parsedMessageArchive = parseAdapterConfig(
  { messageArchives: [{ key: "TestArchiv", count: 250, testToken: " TEST ", experimentalWrite: true }] },
  parserHelpers
).messageArchives[0];
assert.deepStrictEqual(parsedMessageArchive, {
  key: "MA@TestArchiv",
  name: "MA@TestArchiv",
  count: 100,
  testToken: "TEST",
  experimentalWrite: true,
});

const separatedMaConfig = parseAdapterConfig({
  endpointKeys: [{ key: "State_finisch" }, { key: "Licht" }],
  messageArchives: [{ key: "Trockner", testToken: "State_finisch", testText: "legacy text" }],
}, parserHelpers);
assert.deepStrictEqual(separatedMaConfig.endpointKeys, ["CO@STATE_FINISCH", "CO@LICHT"]);
assert.equal(separatedMaConfig.endpointKeys.includes("CO@MA@TROCKNER"), false);
assert.equal(separatedMaConfig.endpointKeys.includes("CO@TROCKNER_AUF"), false);
assert.equal("testText" in separatedMaConfig.messageArchives[0], false);

const foreignPrefixedEndpointConfig = parseAdapterConfig({
  endpointKeys: [
    { key: "MA@Trockner" },
    { key: "DA@Test" },
    { key: "CA@Test" },
    { key: "SC@Test" },
    { key: "SQ@Test" },
    { key: "TI@Test" },
    { key: "VC@Test" },
    { key: "CP@Test" },
    { key: "KLIMASOLLC" },
  ],
}, parserHelpers);
assert.deepStrictEqual(foreignPrefixedEndpointConfig.endpointKeys, ["CO@KLIMASOLLC"]);
assert.equal(isCommunicationObjectKey("MA@Trockner"), false);
assert.equal(isCommunicationObjectKey("DA@Test"), false);
assert.equal(isCommunicationObjectKey("KLIMASOLLC"), true);
assert.equal(isCommunicationObjectKey("CO@STATE_FINISCH"), true);

// A bare MA token is never imported by messageArchives, but remains a CO when
// the administrator explicitly configured the same name as an endpoint.
const explicitTokenCo = parseAdapterConfig({
  endpointKeys: [{ key: "State_finisch" }],
  messageArchives: [{ key: "Trockner", testToken: "State_finisch" }],
}, parserHelpers);
assert.deepStrictEqual(explicitTokenCo.endpointKeys, ["CO@STATE_FINISCH"]);

const mixedSubscriptionKeys = buildSubscriptionKeys([
  "CO@KLIMA_STATUSCODE14B",
  "CO@KLIMASOLLC",
  "CO@KLIMABEFEHLNODE",
], ["MA@Trockner", "ma@trockner"]);
assert.deepStrictEqual(mixedSubscriptionKeys, [
  "CO@KLIMA_STATUSCODE14B",
  "CO@KLIMASOLLC",
  "CO@KLIMABEFEHLNODE",
  "MA@Trockner",
]);
assert.equal(isMessageArchiveKey("MA@Trockner", mixedSubscriptionKeys.slice(3)), true);
assert.equal(isMessageArchiveKey("CO@KLIMASOLLC", mixedSubscriptionKeys.slice(3)), false);
assert.equal(getMessageArchiveSubscriptionKey({
  request: { param: { keys: mixedSubscriptionKeys } },
  data: { items: [{ key: "CO@KLIMASOLLC" }, { key: "MA@Trockner" }] },
}, ["MA@Trockner"]), undefined);

const parsedArchiveString = parseAdapterConfig(
  { dataArchives: "Archiv1 Archiv2" },
  parserHelpers
);
assert.deepStrictEqual(parsedArchiveString.archiveKeys, ["DA@ARCHIV1", "DA@ARCHIV2"]);

const parsedArchiveObject = parseAdapterConfig(
  {
    dataArchives: [
      {
        key: "Archiv1",
        name: "Mein Archiv",
        start: "2024-01-01",
        end: "2024-01-31",
        columns: "a b,c",
      },
    ],
  },
  parserHelpers
);
assert.equal(parsedArchiveObject.archiveDescMap.get("DA@ARCHIV1"), "Mein Archiv");
assert.deepStrictEqual(parsedArchiveObject.archiveQueryDefaults.get("DA@ARCHIV1"), {
  cols: ["a", "b", "c"],
  lastCnt: 50,
  blockSize: 1,
  mode: "manual",
});

const parsedArchiveNewDefaults = parseAdapterConfig(
  {
    dataArchives: [
      {
        key: "Archiv2",
        start: "2607100800",
        cnt: "50",
        size: "1",
        cols: "a b,c",
        lastCnt: "25",
        blockSize: "5",
      },
    ],
  },
  parserHelpers
);
assert.deepStrictEqual(parsedArchiveNewDefaults.archiveQueryDefaults.get("DA@ARCHIV2"), {
  startat: "2607100800",
  cnt: 50,
  size: 1,
  cols: ["a", "b", "c"],
  lastCnt: 25,
  blockSize: 5,
  mode: "last",
});

assert.deepStrictEqual(normalizeArchiveQuery({}), {});
assert.deepStrictEqual(normalizeArchiveQuery({ columns: "a b" }), { cols: ["a", "b"] });
assert.equal(isExecutableArchiveQuery({ startat: "2607100800", cnt: 50, size: 1 }), true);
assert.equal(isExecutableArchiveQuery({ cols: ["#1"] }), false);
assert.equal(isExecutableArchiveQuery({}), false);
assert.deepStrictEqual(
  normalizeArchiveQuery({ start: "2607100800", cnt: "50", size: "1" }),
  { startat: "2607100800", cnt: 50, size: 1 }
);
assert.deepStrictEqual(
  normalizeArchiveQuery({ from: "x", to: "y", columns: "a b" }),
  { cols: ["a", "b"] }
);
assert.equal(isExecutableArchiveQuery(normalizeArchiveQuery({ columns: "a b" })), false);
assert.equal(formatArchiveStartAt(new Date(2026, 6, 10, 8, 0)), "2607100800");
assert.deepStrictEqual(
  buildLastArchiveQuery({ data: { stat: { last: new Date(2026, 6, 10, 8, 50) } } }, 50, 1, ["#1"]),
  { startat: "2607100800", cnt: 50, size: 1, cols: ["#1"] }
);
assert.deepStrictEqual(
  buildLastArchiveQuery({ data: { stat: { last: "1712345678,123" } } }, 1, 1),
  { startat: "2404051933", cnt: 1, size: 1 }
);

const parsedEndpointMapping = parseAdapterConfig(
  {
    endpointGroups: [
      {
        keys: [
          { key: "licht", textEncoding: "latin1", updateOnStart: true },
        ],
      },
    ],
    mappingGroups: [
      {
        mappings: [
          {
            stateId: "alias.0.licht",
            key: "licht",
            toEndpoint: true,
            toState: true,
            updateOnStart: true,
            textEncoding: "latin1",
          },
          {
            stateId: "alias.0.licht",
            key: "licht",
            toEndpoint: true,
            updateOnStart: true,
            textEncoding: "latin1",
          },
        ],
      },
    ],
  },
  parserHelpers
);
assert.equal(parsedEndpointMapping.keyTextEncodingMap.get("CO@LICHT"), "latin1");
assert.deepStrictEqual(parsedEndpointMapping.forwardMap.get("alias.0.licht"), {
  key: "CO@LICHT",
  bool: false,
  textEncoding: "latin1",
});
assert.deepStrictEqual(parsedEndpointMapping.reverseMap.get("CO@LICHT"), {
  stateId: "alias.0.licht",
  bool: false,
  ack: true,
});
assert.equal(
  parsedEndpointMapping.updateOnStartSources.filter((src) => src.stateId === "alias.0.licht").length,
  1
);


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

assert.equal(GIRA_CO_FORMATS[1], "1 Bit");
assert.equal(GIRA_CO_FORMATS[22], "14 Byte String");
assert.equal(getCoMetaFormatText({ format: 14 }), "32 Bit unsigned / Sammelrückmeldeobjekt");
assert.equal(getCoMetaValueType({ format: 1 }), "boolean");
assert.equal(getCoMetaValueType({ format: 22 }), "string");
assert.equal(getCoMetaValueType({ format: 14 }), "number");
assert.equal(getCoMetaValueType({ format: 999 }), "unknown");
assert.deepStrictEqual(encodeUidValue("Drying", false, "latin1", "string"), {
  uidValue: "RHJ5aW5n", ackVal: "Drying", method: "set", encoding: "base64",
});
assert.deepStrictEqual(encodeUidValue("", false, "utf8", "string"), {
  uidValue: "", ackVal: "", method: "set", encoding: "base64",
});
assert.equal(encodeUidValue(null, false, "utf8", "string").uidValue, undefined);
assert.equal(encodeUidValue(undefined, false, "utf8", "string").uidValue, undefined);
assert.equal(encodeUidValue(false, false, "utf8", "boolean").uidValue, "0");
assert.equal(encodeUidValue(true, false, "utf8", "boolean").uidValue, "1");
assert.equal(encodeUidValue("Drying", true, "utf8", "string").uidValue, "RHJ5aW5n");
assert.equal(encodeUidValue(123, false, "utf8", "number").uidValue, "123");
assert.equal(encodeUidValue("12.5", false, "utf8", "number").uidValue, "12.5");
assert.equal(encodeUidValue("abc", false, "utf8", "number").uidValue, undefined);
assert.equal(encodeUidValue(NaN, false, "utf8", "number").uidValue, undefined);
assert.equal(encodeUidValue(Infinity, false, "utf8", "number").uidValue, undefined);
assert.equal(encodeUidValue(-Infinity, false, "utf8", "number").uidValue, undefined);

try {
  const path = require("path");
  const { tests } = require("@iobroker/testing");

  // Run basic integration tests for the adapter when the optional harness is installed.
  tests.integration(path.join(__dirname, ".."));
} catch (err) {
  if (err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes("@iobroker/testing")) {
    console.warn("Skipping ioBroker integration tests because @iobroker/testing is not installed.");
  } else {
    throw err;
  }
}
