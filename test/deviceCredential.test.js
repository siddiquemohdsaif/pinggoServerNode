"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const AES = require("../utils/AES_256");
const { credentialDeviceId } = require("../realtime/websocketServer");
const { deviceActivityData } = require("../realtime/fcmService");
const { registeredFcmToken, registeredDeviceRole } = require("../models/DeviceStore");

test("linked-device credentials are bound to one installation", () => {
  const encrypted = AES.getEncryptedCredential("919999999999", "device:companion-device");
  const claims = AES.getEncryptedCredentialClaims(encrypted);

  assert.equal(claims.uid, "919999999999");
  assert.equal(claims.deviceId, "companion-device");
  assert.notEqual(claims.deviceId, "another-device");
});

test("authorization parser preserves the device binding", () => {
  const encrypted = AES.getEncryptedCredential("919999999999", "device:companion-device");
  const request = { headers: { authorization: `Bearer 919999999999_${encrypted}` } };

  assert.deepEqual(AES.getHeaderCredentialClaims(request), {
    uid: "919999999999",
    context: "device:companion-device",
    deviceId: "companion-device",
    encryptedCredential: encrypted,
  });
});

test("tampering with an authenticated linked-device credential invalidates it", () => {
  const encrypted = AES.getEncryptedCredential("919999999999", "device:companion-device");
  const replacement = encrypted.endsWith("A") ? "B" : "A";
  const tampered = encrypted.slice(0, -1) + replacement;

  assert.equal(AES.getEncryptedCredentialClaims(tampered), null);
  assert.equal(AES.validateEncryptedCredentialByUID(tampered, "919999999999"), false);
});

test("revocation lookup applies only to device-bound credentials", () => {
  const accountCredential = AES.getEncryptedCredential("919999999999", "P_ID");
  const accountClaims = AES.getEncryptedCredentialClaims(accountCredential);
  const companionCredential = AES.getEncryptedCredential(
    "919999999999",
    "device:companion-device",
  );
  const companionClaims = AES.getEncryptedCredentialClaims(companionCredential);

  assert.equal(credentialDeviceId(accountClaims), "");
  assert.equal(credentialDeviceId(companionClaims), "companion-device");
});

test("device notification payload distinguishes login, link, detach and self logout", () => {
  const device = { deviceId: "companion-device", name: "Pixel Tablet" };
  const login = deviceActivityData({
    accountId: "919999999999", event: "device_login",
    device: { deviceId: "new-primary", name: "Pixel 9" },
    actorDeviceId: "new-primary",
  });
  const linked = deviceActivityData({
    accountId: "919999999999", event: "device_linked", device,
    actorDeviceId: "companion-device",
  });
  const detached = deviceActivityData({
    accountId: "919999999999", event: "device_unlinked", device,
    actorDeviceId: "primary-device",
  });
  const selfLogout = deviceActivityData({
    accountId: "919999999999", event: "device_unlinked", device,
    actorDeviceId: "companion-device",
  });

  assert.equal(linked.type, "device_linked");
  assert.equal(login.type, "device_login");
  assert.equal(login.deviceId, "new-primary");
  assert.equal(login.deviceName, "Pixel 9");
  assert.equal(login.reason, "login");
  assert.equal(linked.accountId, "919999999999");
  assert.equal(linked.deviceId, "companion-device");
  assert.equal(linked.deviceName, "Pixel Tablet");
  assert.equal(linked.reason, "linked");
  assert.match(linked.changedAt, /^\d+$/);
  assert.equal(detached.reason, "detached");
  assert.equal(selfLogout.reason, "self_logout");
});

test("metadata registration does not erase an uploaded FCM token", () => {
  assert.equal(registeredFcmToken({}, { fcmToken: "primary-token" }), "primary-token");
  assert.equal(registeredFcmToken(
    { fcmToken: "refreshed-token" }, { fcmToken: "primary-token" }), "refreshed-token");
});

test("server-derived registration repairs a stale device role", () => {
  assert.equal(registeredDeviceRole(
    { role: "primary" }, { role: "companion" }, [{}]), "primary");
  assert.equal(registeredDeviceRole(
    { role: "companion" }, { role: "primary" }, [{}]), "companion");
});
