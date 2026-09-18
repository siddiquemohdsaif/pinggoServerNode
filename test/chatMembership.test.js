const assert = require("node:assert/strict");
const test = require("node:test");
const { isDirectChatParticipant, filterChatListForUser, chatEntries } = require("../utils/chatMembership");

test("flat chat fields exclude metadata and reject old list layouts", () => {
  const settings = { pinned: true };
  assert.deepEqual(chatEntries({ _id: "123", updatedAt: 5, "123_456": settings, grp_test: settings }),
    { "123_456": settings, grp_test: settings });
  assert.throws(() => chatEntries({ list: { "123_456": settings } }), /Migrate/);
  assert.throws(() => chatEntries({ list: ["123_456"] }), /Migrate/);
  assert.throws(() => chatEntries({ __listStorage: { version: 1 } }), /Migrate/);
});

test("conference participant cannot acquire another pair's direct chat", () => {
  const chatId = "919867400865_917710867126";
  assert.equal(isDirectChatParticipant(chatId, "919867180719"), false);
  assert.equal(isDirectChatParticipant(chatId, "+919867400865"), true);
  assert.equal(isDirectChatParticipant(chatId, "917710867126"), true);
  assert.equal(isDirectChatParticipant("1_2_3", "1"), false);
});

test("list filtering preserves settings and groups and removes unrelated unread chats", () => {
  const settings = { unread_count: 3 };
  const list = { "919867400865_917710867126": settings,
    "917710867126_919867180719": settings, "grp_example": settings };
  assert.deepEqual(filterChatListForUser(list, "919867180719"), {
    "917710867126_919867180719": settings, "grp_example": settings });
  assert.throws(() => filterChatListForUser(Object.keys(list), "919867180719"), /per-item/);
});
