"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addUser,
  removeUser,
  getUserSockets,
  sendToUser,
  disconnectDevice,
  notifyDeviceUnlinked,
  resolveUnlinkActorDeviceId,
  disconnectAccount,
  isUserOnline,
  isUserViewingChat,
} = require("../realtime/connectionManager");

function socket() {
  return { closeCalls: [], sent: [], readyState: 1,
    send(value) { this.sent.push(JSON.parse(value)); },
    close(code, reason) { this.closeCalls.push({ code, reason }); } };
}

test("one account can keep several device sockets online", () => {
  const account = `multi-${Date.now()}`;
  const phone = socket();
  const tablet = socket();
  addUser(account, "phone-device", phone);
  addUser(account, "tablet-device", tablet);

  assert.equal(getUserSockets(account).length, 2);
  assert.equal(phone.closeCalls.length, 0);
  assert.equal(tablet.closeCalls.length, 0);
  assert.equal(isUserOnline(account), true);

  removeUser(account, phone);
  assert.equal(getUserSockets(account).length, 1);
  assert.equal(isUserOnline(account), true);
  removeUser(account, tablet);
  assert.equal(isUserOnline(account), false);
});

test("a reconnect replaces only the socket for the same device", () => {
  const account = `replace-${Date.now()}`;
  const oldPhone = socket();
  const newPhone = socket();
  const tablet = socket();
  addUser(account, "phone-device", oldPhone);
  addUser(account, "tablet-device", tablet);
  addUser(account, "phone-device", newPhone);

  assert.equal(oldPhone.closeCalls.length, 1);
  assert.deepEqual(getUserSockets(account), [newPhone, tablet]);
  removeUser(account, newPhone);
  removeUser(account, tablet);
});

test("fan-out can exclude the originating device", () => {
  const account = `fanout-${Date.now()}`;
  const phone = socket();
  const tablet = socket();
  addUser(account, "phone-device", phone);
  addUser(account, "tablet-device", tablet);
  const delivered = [];
  const count = sendToUser(account, { type: "sync" },
    (target, payload) => delivered.push({ target, payload }), { exceptSocket: phone });

  assert.equal(count, 1);
  assert.equal(delivered[0].target, tablet);
  tablet.activeChatId = "chat-1";
  assert.equal(isUserViewingChat(account, "chat-1"), true);
  removeUser(account, phone);
  removeUser(account, tablet);
});

test("an incoming account event reaches both primary and companion", () => {
  const account = `delivery-${Date.now()}`;
  const primary = socket();
  const companion = socket();
  addUser(account, "primary-device", primary);
  addUser(account, "companion-device", companion);
  const delivered = [];

  const count = sendToUser(account, { type: "new_message", message: { id: "message-1" } },
    (target, payload) => delivered.push({ target, payload }));

  assert.equal(count, 2);
  assert.deepEqual(delivered.map((entry) => entry.target), [primary, companion]);
  assert.ok(delivered.every((entry) => entry.payload.message.id === "message-1"));
  removeUser(account, primary);
  removeUser(account, companion);
});

test("revoking a companion closes only that device socket", () => {
  const account = `revoke-${Date.now()}`;
  const primary = socket();
  const companion = socket();
  addUser(account, "primary-device", primary);
  addUser(account, "companion-device", companion);

  assert.equal(disconnectDevice(account, "companion-device"), true);
  assert.equal(companion.closeCalls.length, 1);
  assert.equal(companion.closeCalls[0].code, 4003);
  assert.equal(primary.closeCalls.length, 0);

  removeUser(account, primary);
  removeUser(account, companion);
});

test("companion self-logout notifies primary and companion immediately", () => {
  const account = `self-logout-${Date.now()}`;
  const primary = socket();
  const companion = socket();
  addUser(account, "primary-device", primary);
  addUser(account, "companion-device", companion);

  assert.equal(notifyDeviceUnlinked(account, "companion-device",
    "companion-device", 123456), 2);
  for (const target of [primary, companion]) {
    assert.deepEqual(target.sent[0], {
      type: "device_unlinked",
      deviceId: "companion-device",
      actorDeviceId: "companion-device",
      reason: "self_logout",
      message: "",
      revokedAt: 123456,
    });
  }

  removeUser(account, primary);
  removeUser(account, companion);
});

test("primary unlink tells the companion why it was logged out", () => {
  const account = `primary-unlink-${Date.now()}`;
  const primary = socket();
  const companion = socket();
  addUser(account, "primary-device", primary);
  addUser(account, "companion-device", companion);

  notifyDeviceUnlinked(account, "companion-device", "primary-device", 654321);
  assert.equal(companion.sent[0].type, "device_unlinked");
  assert.equal(companion.sent[0].reason, "device_unlinked");
  assert.equal(companion.sent[0].message,
    "This companion device was logged out by the primary device.");

  removeUser(account, primary);
  removeUser(account, companion);
});

test("account-bound unlink requests are attributed to the primary", () => {
  assert.equal(resolveUnlinkActorDeviceId(""), "primary");
  assert.equal(resolveUnlinkActorDeviceId("companion-device"), "companion-device");
});

test("account logout notifies and closes every connected device", () => {
  const account = `account-logout-${Date.now()}`;
  const primary = socket();
  const companion = socket();
  addUser(account, "primary-device", primary);
  addUser(account, "companion-device", companion);

  assert.equal(disconnectAccount(account, {
    type: "account_logout", reason: "primary_logout",
  }), 2);
  for (const target of [primary, companion]) {
    assert.equal(target.sent[0].type, "account_logout");
    assert.equal(target.closeCalls[0].code, 4003);
  }
  removeUser(account, primary);
  removeUser(account, companion);
});
