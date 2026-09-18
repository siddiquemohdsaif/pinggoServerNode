const assert = require("node:assert/strict");
const test = require("node:test");
const FirestoreManager = require("../Firestore/FirestoreManager");
const account = "919867180719";
const first = "97b4d22d-9675-4d06-a40d-6b260ddbd5ad";
const second = "cfddb8b8-c0f9-4d77-9e71-d4e7388cce11";
let documents = {};
FirestoreManager._instance = {
  async readDocument(collection) { return documents[collection] ? structuredClone(documents[collection]) : null; },
  async createDocument(collection, id, parent, body) { documents[collection] = structuredClone({ ...body, _id: id }); },
  async updateDocument(collection, id, parent, body) {
    assert.equal(body.__listStorage, undefined);
    documents[collection] = structuredClone({ ...documents[collection], ...body });
  },
  async deleteField(collection, parent, id, field) { delete documents[collection][field]; },
};
const DeviceStore = require("../models/DeviceStore");
const UserDeviceInfo = require("../models/UserDeviceInfoStore");

test("normal login only registers UserDeviceInfo; refresh preserves login time and token", async () => {
  documents = {};
  await DeviceStore.registerDevice(account, { deviceId: first, fcmToken: "primary-token" }, { login: true });
  assert.equal(documents.LinkedDevices, undefined);
  const before = documents.UserDeviceInfo.devices[first];
  await DeviceStore.registerDevice(account, { deviceId: first });
  assert.equal(documents.UserDeviceInfo.devices[first].lastLoginAt, before.lastLoginAt);
  assert.equal(documents.UserDeviceInfo.devices[first].fcmToken, "primary-token");
  assert.deepEqual(await DeviceStore.getPrimaryFcmTokens(account), ["primary-token"]);
  assert.equal((await DeviceStore.getFcmRegistration(account)).registryExists, true);
});

test("only pairing creates links; unlink archives metadata and records logout", async () => {
  documents = {};
  await assert.rejects(DeviceStore.registerDevice(account, { deviceId: second, role: "companion" }), /not linked/);
  await DeviceStore.linkDevice(account, { deviceId: second, name: "Companion", fcmToken: "companion-token" });
  assert.equal((await DeviceStore.listDevices(account)).length, 1);
  assert.equal(documents.UserDeviceInfo.devices[second].loggedIn, true);
  assert.equal(await DeviceStore.revokeDevice(account, second), true);
  assert.equal(documents.LinkedDevices.devices[second], undefined);
  const history = await DeviceStore.listOldDevices(account);
  assert.equal(history.length, 1);
  assert.equal(history[0].name, "Companion");
  assert.equal(history[0].fcmToken, "");
  assert.equal(documents.UserDeviceInfo.devices[second].loggedIn, false);
  assert.equal(await DeviceStore.isDeviceRevoked(account, second), true);
  await assert.rejects(DeviceStore.registerDevice(account, { deviceId: second, role: "companion" }), /not linked/);
  await DeviceStore.linkDevice(account, { deviceId: second });
  assert.equal(documents.UserDeviceInfo.devices[second].loggedIn, true);
  assert.equal((await DeviceStore.listOldDevices(account)).length, 1);
});

test("account logout updates all devices, archives companions, and clears notification routing", async () => {
  documents = {};
  await DeviceStore.registerDevice(account, { deviceId: first, fcmToken: "primary-token" }, { login: true });
  await DeviceStore.linkDevice(account, { deviceId: second, fcmToken: "companion-token" });
  const result = await DeviceStore.revokeAllDevices(account);
  assert.deepEqual(result.notificationTokens.sort(), ["companion-token", "primary-token"]);
  assert.equal(result.revokedCount, 2);
  assert.equal((await DeviceStore.listDevices(account)).length, 0);
  assert.equal((await DeviceStore.listOldDevices(account)).length, 1);
  assert.ok((await UserDeviceInfo.listDevices(account)).every(device => !device.loggedIn && !device.fcmToken));
  assert.deepEqual(await DeviceStore.getFcmTokens(account), []);
  assert.equal(await DeviceStore.getSessionRevokedAt(account), result.revokedAt);
  await DeviceStore.registerDevice(account, { deviceId: first }, { login: true });
  assert.equal(await DeviceStore.isDeviceRevoked(account, first), false);
});

test("reads preserve old primary records and exclude them from linked devices", async () => {
  documents = { LinkedDevices: { devices: { [first]: {
    deviceId: first, role: "primary", linkedAt: 100, fcmToken: "legacy-token", revokedAt: null,
  } } } };
  const before = structuredClone(documents);
  assert.deepEqual(await DeviceStore.listDevices(account), []);
  assert.deepEqual(await DeviceStore.getPrimaryFcmTokens(account), ["legacy-token"]);
  assert.deepEqual(documents, before);
  await DeviceStore.registerDevice(account, { deviceId: first, fcmToken: "new-token" }, { login: true });
  await UserDeviceInfo.logoutDevice(account, first);
  assert.deepEqual(await DeviceStore.getFcmTokens(account), []);
});

test("explicit unlink records logout even for a companion linked before UserDeviceInfo existed", async () => {
  documents = { LinkedDevices: { devices: { [second]: {
    deviceId: second, role: "companion", name: "Older companion", linkedAt: 100,
    fcmToken: "older-token", revokedAt: null,
  } } } };
  assert.equal(await DeviceStore.revokeDevice(account, second), true);
  assert.equal(documents.UserDeviceInfo.devices[second].loggedIn, false);
  assert.equal(documents.UserDeviceInfo.devices[second].name, "Older companion");
  assert.equal((await DeviceStore.listOldDevices(account))[0].linkedAt, 100);
});
