const assert = require("node:assert/strict");
const test = require("node:test");

test("attachment collections are selected from the chat id", () => {
  const { collectionForChat } = require("../models/ChatAttachmentStore");
  assert.equal(collectionForChat("123_456"), "ChatAttachments");
  assert.equal(collectionForChat("grp_example"), "GroupAttachments");
});
