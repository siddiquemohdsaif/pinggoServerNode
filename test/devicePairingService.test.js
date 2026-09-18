"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DevicePairingService, LINK_TTL_MS } = require("../services/devicePairingService");
const { MAX_DEVICES } = require("../models/DeviceStore");

function fixture(deviceCount = 1) {
  const records = new Map();
  const requests = {
    async create(value) { records.set(value.linkRequestId, structuredClone(value)); },
    async read(id) { return records.has(id) ? structuredClone(records.get(id)) : null; },
    async write(id, value) { records.set(id, structuredClone(value)); },
  };
  const active = Array.from({ length: deviceCount }, (_, index) => ({
    deviceId: `active-device-${index}`, role: "companion",
  }));
  let sessionRevokedAt = 0;
  const devices = {
    MAX_DEVICES,
    async listDevices() { return structuredClone(active); },
    async getSessionRevokedAt() { return sessionRevokedAt; },
    async registerDevice() { throw new Error("Pairing must use linkDevice, not login registration."); },
    async linkDevice(_accountId, input) {
      if (!active.some((item) => item.deviceId === input.deviceId)) {
        if (active.length >= MAX_DEVICES) throw Object.assign(new Error("maximum"), { statusCode: 409 });
        active.push({ ...input });
      }
      return { ...input, role: "companion" };
    },
  };
  let now = 1_000_000;
  const service = new DevicePairingService({ requests, devices, now: () => now,
    issueCredential: (accountId, deviceId) => `credential:${accountId}:${deviceId}`,
    getUserData: async (accountId) => ({
      _id: accountId,
      phoneNumber: accountId,
      encryptedCredential: "primary-secret-must-not-leak",
      profileData: {
        name: "Linked User",
        phoneNumber: accountId,
        email: "USER@EXAMPLE.COM",
        profilePhotoUrl: "https://example.com/profile.jpg",
        P_ID: "private-personal-id",
      },
    }) });
  return { service, advance(ms) { now += ms; }, revokeAccount() { sessionRevokedAt = now; } };
}

async function approved(f) {
  const link = await f.service.createLinkRequest({ deviceId: "companion-device", name: "Tablet" });
  await f.service.approve({ accountId: "919999999999", approvingDeviceId: "primary-device",
    linkRequestId: link.linkRequestId, pairingSecret: link.pairingSecret });
  return link;
}

test("attacker with only a request id cannot inspect or complete pairing", async () => {
  const f = fixture();
  const link = await f.service.createLinkRequest({ deviceId: "companion-device" });
  await assert.rejects(() => f.service.status({ linkRequestId: link.linkRequestId }), /required/);
  await assert.rejects(() => f.service.complete({ linkRequestId: link.linkRequestId,
    pairingSecret: "attacker-secret" }), /not found/);
});

test("expired request cannot be approved", async () => {
  const f = fixture();
  const link = await f.service.createLinkRequest({ deviceId: "companion-device" });
  f.advance(LINK_TTL_MS + 1);
  await assert.rejects(() => f.service.approve({ accountId: "919999999999",
    approvingDeviceId: "primary-device", linkRequestId: link.linkRequestId,
    pairingSecret: link.pairingSecret }), (error) => error.statusCode === 410);
});

test("completed request cannot be reused", async () => {
  const f = fixture();
  const link = await approved(f);
  const result = await f.service.complete({ linkRequestId: link.linkRequestId,
    pairingSecret: link.pairingSecret });
  assert.equal(result.deviceId, "companion-device");
  assert.equal(result.encryptedCredential, "credential:919999999999:companion-device");
  await assert.rejects(() => f.service.complete({ linkRequestId: link.linkRequestId,
    pairingSecret: link.pairingSecret }), /not found|already/);
});

test("active companion limit is enforced during approval", async () => {
  assert.equal(MAX_DEVICES, 4);
  const f = fixture(MAX_DEVICES);
  const link = await f.service.createLinkRequest({ deviceId: "extra-companion" });
  await assert.rejects(() => f.service.approve({ accountId: "919999999999",
    approvingDeviceId: "primary-device", linkRequestId: link.linkRequestId,
    pairingSecret: link.pairingSecret }), (error) => error.statusCode === 409);
});

test("pairing can fill the last companion slot using linkDevice", async () => {
  const f = fixture(MAX_DEVICES - 1);
  const link = await approved(f);
  const result = await f.service.complete({ linkRequestId: link.linkRequestId,
    pairingSecret: link.pairingSecret });
  assert.equal(result.device.role, "companion");
});

test("completion issues a credential only for the requested companion device", async () => {
  const f = fixture();
  const link = await approved(f);
  const result = await f.service.complete({ linkRequestId: link.linkRequestId,
    pairingSecret: link.pairingSecret });

  assert.equal(result.accountId, "919999999999");
  assert.equal(result.deviceId, "companion-device");
  assert.equal(result.encryptedCredential,
    "credential:919999999999:companion-device");
  assert.equal(Object.hasOwn(result, "approvingCredential"), false);
  assert.equal(result.userData._id, "919999999999");
  assert.equal(result.userData.phoneNumber, "919999999999");
  assert.equal(result.userData.profileData.name, "Linked User");
  assert.equal(result.userData.profileData.phoneNumber, "919999999999");
  assert.equal(result.userData.profileData.email, "user@example.com");
  assert.equal(result.userData.profileData.profilePhotoUrl,
    "https://example.com/profile.jpg");
  assert.equal(result.userData.encryptedCredential,
    "credential:919999999999:companion-device");
  assert.equal(Object.hasOwn(result.userData.profileData, "P_ID"), false);
  assert.notEqual(result.userData.encryptedCredential, "primary-secret-must-not-leak");
});

test("concurrent completion consumes a QR exactly once", async () => {
  const f = fixture();
  const link = await approved(f);
  const attempts = await Promise.allSettled([
    f.service.complete({ linkRequestId: link.linkRequestId, pairingSecret: link.pairingSecret }),
    f.service.complete({ linkRequestId: link.linkRequestId, pairingSecret: link.pairingSecret }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
});

test("primary logout invalidates a QR that was already approved", async () => {
  const f = fixture();
  const link = await approved(f);
  f.advance(1);
  f.revokeAccount();

  await assert.rejects(() => f.service.complete({ linkRequestId: link.linkRequestId,
    pairingSecret: link.pairingSecret }), /primary account logged out/);
});
