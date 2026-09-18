const assert = require("node:assert/strict");
const test = require("node:test");
const { cleanupPlan, removeMarkers } = require("./removeListStorageMarker");

function fixture(metadata = {}) {
  const raw = { _id: "123", __listStorage: { version: 1, field: "list", metadata },
    "14160831243_919867180719": { pinned: false, last_message: { messageType: 2 } } };
  const writes = [];
  return { raw, writes, firestore: {
    async readCollectionDocumentIds() { return ["123"]; },
    async readDocument() { return structuredClone(raw); },
    async updateDocument(collection, id, parent, updates) { writes.push("update"); Object.assign(raw, updates); },
    async deleteField(collection, parent, id, field) { writes.push(field); delete raw[field]; },
  } };
}

test("cleanup defaults to dry-run and preserves every entry", async () => {
  const f = fixture();
  await removeMarkers(f.firestore, { collections: ["ChatsList"], report() {} });
  assert.deepEqual(f.writes, []);
  assert.ok(f.raw.__listStorage);
});

test("execution removes only the marker and restores metadata first", async () => {
  const f = fixture({ ownerId: "123", permissions: { editInfo: "admins" } });
  const entry = structuredClone(f.raw["14160831243_919867180719"]);
  await removeMarkers(f.firestore, { collections: ["ChatsList"], execute: true, report() {} });
  assert.deepEqual(f.writes, ["update", "__listStorage"]);
  assert.equal(f.raw.__listStorage, undefined);
  assert.equal(f.raw.ownerId, "123");
  assert.deepEqual(f.raw.permissions, { editInfo: "admins" });
  assert.deepEqual(f.raw["14160831243_919867180719"], entry);
  f.writes.length = 0;
  await removeMarkers(f.firestore, { collections: ["ChatsList"], execute: true, report() {} });
  assert.deepEqual(f.writes, []);
});

test("conflicting metadata or unknown schemas never trigger deletion", async () => {
  const f = fixture({ ownerId: "original" });
  f.raw.ownerId = "different";
  await assert.rejects(removeMarkers(f.firestore,
    { collections: ["ChatsList"], execute: true, report() {} }), /conflicts/);
  assert.deepEqual(f.writes, []);
  f.raw.__listStorage.version = 2;
  assert.throws(() => cleanupPlan("ChatsList", f.raw), /Unsupported/);
  assert.equal(cleanupPlan("ChatsList", { _id: "123" }), null);
});

test("failed metadata restoration leaves the marker intact", async () => {
  const f = fixture({ ownerId: "123" });
  f.firestore.updateDocument = async () => { throw new Error("network failed"); };
  await assert.rejects(removeMarkers(f.firestore,
    { collections: ["ChatsList"], execute: true, report() {} }), /network failed/);
  assert.ok(f.raw.__listStorage);
  assert.deepEqual(f.writes, []);
});
