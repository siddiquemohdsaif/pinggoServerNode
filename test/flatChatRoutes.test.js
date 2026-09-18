const assert = require("node:assert/strict");
const test = require("node:test");
const FirestoreManager = require("../Firestore/FirestoreManager");
const own = "919867180719";
const chatId = "14160831243_" + own;
let document;
let calls = [];
FirestoreManager._instance = {
  async readDocument(collection) {
    calls.push(collection);
    return collection === "ChatsList" ? structuredClone(document) : null;
  },
  async bulkReadDocuments() { return []; },
  async readCollectionDocumentIds() { return []; },
  async updateDocument(collection, id, parent, updates) {
    assert.equal(collection, "ChatsList");
    assert.equal(updates.list, undefined);
    assert.equal(updates.__listStorage, undefined);
    document = { ...document, ...updates };
  },
  async deleteField(collection, parent, id, field) { delete document[field]; },
};
const router = require("../routes/chats");
async function request(path, body) {
  let result;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { result = value; return this; } };
  const route = router.stack.find(layer => layer.route?.path === path);
  await route.route.stack[0].handle({ body }, res);
  return { status: res.statusCode, result };
}

test("flat chat list loads and single/bulk settings mutate only item fields", async () => {
  document = { _id: own, [chatId]: { pinned: false, unread_count: 1 },
    "919867400865_917710867126": { unread_count: 3 } };
  let response = await request("/list", { phoneNumber: own });
  assert.equal(response.status, 200);
  assert.deepEqual(response.result.userProfiles.map(profile => profile.chatId), [chatId]);
  assert.equal(response.result.total_unread, 1);
  response = await request("/settings", { phoneNumber: own, chatId, setting: "pin", value: 1 });
  assert.equal(response.status, 200);
  assert.equal(document[chatId].pinned, true);
  response = await request("/settings/bulk", { phoneNumber: own, chatIds: [chatId], setting: "delete", value: 1 });
  assert.equal(response.status, 200);
  assert.equal(document[chatId], undefined);
  assert.ok(document["919867400865_917710867126"]);
});

test("legacy nested chat lists are not used as a fallback", async () => {
  document = { _id: own, list: { [chatId]: { pinned: true } } };
  const response = await request("/list", { phoneNumber: own });
  assert.equal(response.status, 400);
  assert.match(response.result.message, /Migrate/);
});

test("calls timeline never consults the old CallsList index", async () => {
  calls = [];
  const { getCallsList } = require("../models/CallLogStore");
  const response = await getCallsList(own, 20, null);
  assert.deepEqual(response.calls, []);
  assert.equal(calls.includes("CallsList"), false);
});
