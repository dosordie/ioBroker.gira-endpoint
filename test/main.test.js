const assert = require("assert").strict;
const { encodeUidValue, decodeCoValue } = require("../build/lib/valueConversion");
const { parseAdapterConfig } = require("../build/lib/configParser");
const { normalizeArchiveQuery, buildLastArchiveQuery, formatArchiveStartAt } = require("../build/lib/archiveQuery");

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

const parsedConnection = parseAdapterConfig(
  { host: " 1.2.3.4 ", port: "81", ssl: true, authHeader: true },
  parserHelpers
);
assert.equal(parsedConnection.connection.host, "1.2.3.4");
assert.equal(parsedConnection.connection.port, 81);
assert.equal(parsedConnection.connection.ssl, true);
assert.equal(parsedConnection.connection.path, "/endpoints/ws");
assert.equal(parsedConnection.connection.authHeader, true);

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

assert.deepStrictEqual(normalizeArchiveQuery({ columns: "a b" }), { cols: ["a", "b"] });
assert.deepStrictEqual(
  normalizeArchiveQuery({ start: "2607100800", cnt: "50", size: "1" }),
  { startat: "2607100800", cnt: 50, size: 1 }
);
assert.deepStrictEqual(
  normalizeArchiveQuery({ from: "x", to: "y", columns: "a b" }),
  { cols: ["a", "b"] }
);
assert.equal(formatArchiveStartAt(new Date(2026, 6, 10, 8, 0)), "2607100800");
assert.deepStrictEqual(
  buildLastArchiveQuery({ data: { stat: { last: new Date(2026, 6, 10, 8, 50) } } }, 50, 1, ["#1"]),
  { startat: "2607100800", cnt: 50, size: 1, cols: ["#1"] }
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
