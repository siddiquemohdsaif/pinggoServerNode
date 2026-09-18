"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const FirestoreManager = require("../Firestore/FirestoreManager");
const deviceCollections = ["LinkedDevices", "OldLinkedDevices", "UserDeviceInfo"];
const calls = [];
// All cleanup operations in this test use an in-memory mock, never the database.
FirestoreManager._instance = {
  async readCollectionDocumentIds(collection, parent) {
    calls.push(["list", collection, parent]);
    return ["test-account"];
  },
  async deleteDocument(collection, account, parent) {
    calls.push(["delete", collection, account, parent]);
  },
};
const { COLLECTIONS_TO_CLEAN, cleanCollection } = require("../cleanDB");

test("importing cleanDB does not execute cleanup", () => {
  assert.deepEqual(calls, []);
});

test("reset includes all three device registries and preserves AppConfiguration", () => {
  for (const collection of deviceCollections)
    assert.equal(COLLECTIONS_TO_CLEAN.filter(item => item === collection).length, 1);
  assert.equal(COLLECTIONS_TO_CLEAN.includes("DeviceLinkRequests"), true);
  assert.equal(COLLECTIONS_TO_CLEAN.includes("AppConfiguration"), false);
  assert.equal(new Set(COLLECTIONS_TO_CLEAN).size, COLLECTIONS_TO_CLEAN.length);
});

test("device registry cleanup deletes account documents using the mock SDK", async () => {
  calls.length = 0;
  for (const collection of deviceCollections) {
    const result = await cleanCollection(collection);
    assert.equal(result.deleted, 1);
    assert.deepEqual(result.failures, []);
  }
  assert.deepEqual(calls, deviceCollections.flatMap(collection => [
    ["list", collection, "/"],
    ["delete", collection, "test-account", "/"],
  ]));
});
