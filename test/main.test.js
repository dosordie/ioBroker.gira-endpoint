const path = require("path");
const { tests } = require("@iobroker/testing");

// Run basic integration tests for the adapter
// This will use the default ioBroker testing harness
// and ensure the adapter can be started and stopped.
tests.integration(path.join(__dirname, ".."));
