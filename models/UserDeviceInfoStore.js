"use strict";
const FirestoreManager = require("../Firestore/FirestoreManager");
const firestore = FirestoreManager.getInstance();
const locks = new Map();
const accountId = value => String(value || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");

async function read(account) {
  try { return await firestore.readDocument("UserDeviceInfo", accountId(account), "/"); }
  catch (_error) { return null; }
}
async function save(account, prior, updates) {
  const body = { ...(prior || {}), ...updates, accountId: accountId(account), updatedAt: Date.now() };
  delete body._id;
  if (prior) await firestore.updateDocument("UserDeviceInfo", accountId(account), "/", { ...body });
  else await firestore.createDocument("UserDeviceInfo", accountId(account), "/", { ...body });
}
async function locked(account, operation) {
  const key = accountId(account);
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  locks.set(key, current);
  try { return await current; }
  finally { if (locks.get(key) === current) locks.delete(key); }
}

async function registerDevice(account, input, { login = false } = {}) {
  if (!accountId(account) || !/^[A-Za-z0-9._:-]{8,128}$/.test(String(input.deviceId || "")))
    throw Object.assign(new Error("A valid deviceId is required."), { statusCode: 400 });
  return locked(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    const prior = devices[input.deviceId] || {};
    const now = Date.now();
    const active = login || prior.loggedIn !== false;
    const device = { ...prior, deviceId: input.deviceId,
      name: String(input.name || prior.name || "Android device").slice(0, 100),
      platform: String(input.platform || prior.platform || "android").slice(0, 30),
      role: input.role || prior.role || "primary",
      appVersion: String(input.appVersion || prior.appVersion || "").slice(0, 30),
      fcmToken: String(input.fcmToken || prior.fcmToken || "").slice(0, 4096),
      firstLoginAt: prior.firstLoginAt || now,
      lastLoginAt: login || !prior.lastLoginAt ? now : prior.lastLoginAt,
      lastLogoutAt: prior.lastLogoutAt || null, lastSeenAt: now,
      loggedIn: active, status: active ? "logged_in" : "logged_out",
      revokedAt: active ? null : prior.revokedAt };
    devices[input.deviceId] = device;
    await save(account, document, { devices, version: Number(document?.version || 0) + 1 });
    return device;
  });
}

async function logoutDevice(account, deviceId, reason = "logout", time = Date.now()) {
  return locked(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    if (!devices[deviceId]) return false;
    devices[deviceId] = { ...devices[deviceId], loggedIn: false, status: "logged_out",
      lastLogoutAt: time, revokedAt: time, logoutReason: reason, fcmToken: "" };
    await save(account, document, { devices, version: Number(document.version || 0) + 1 });
    return true;
  });
}
async function logoutAll(account, time = Date.now()) {
  return locked(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    const active = Object.values(devices).filter(device => device.loggedIn !== false);
    const tokens = [...new Set(active.map(device => device.fcmToken).filter(Boolean))];
    for (const device of active) devices[device.deviceId] = { ...device, loggedIn: false,
      status: "logged_out", lastLogoutAt: time, revokedAt: time, logoutReason: "account_logout", fcmToken: "" };
    await save(account, document, { devices, sessionRevokedAt: time,
      version: Number(document?.version || 0) + 1 });
    return { notificationTokens: tokens, revokedCount: active.length, revokedAt: time };
  });
}
async function getDevice(account, deviceId) { return (await read(account))?.devices?.[deviceId] || null; }
async function listDevices(account) { return Object.values((await read(account))?.devices || {}); }
async function getSessionRevokedAt(account) { return Number((await read(account))?.sessionRevokedAt || 0); }
async function hasRegistry(account) { return Boolean(await read(account)); }
module.exports = { registerDevice, logoutDevice, logoutAll, getDevice, listDevices, getSessionRevokedAt, hasRegistry };
