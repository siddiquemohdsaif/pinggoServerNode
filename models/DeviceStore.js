"use strict";

const FirestoreManager = require("../Firestore/FirestoreManager");
const firestore = FirestoreManager.getInstance();
const UserDeviceInfo = require("./UserDeviceInfoStore");
const COLLECTION = "LinkedDevices";
const MAX_DEVICES = 4; // companion links only; primary login is tracked separately
const accountLocks = new Map();

function id(value) {
  return typeof value === "string" ? value.trim().replace(/^<plus>/, "").replace(/^\+/, "") : "";
}
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function withoutId(value) { const copy = { ...(value || {}) }; delete copy._id; return copy; }

function flatDeviceEntries(document) {
  return Object.entries(document || {}).filter(([key, value]) => value
    && typeof value === "object" && !Array.isArray(value)
    && typeof value.deviceId === "string" && value.deviceId
    && (key === value.deviceId || key === "__listEntry_"
      + Buffer.from(value.deviceId, "utf8").toString("base64url")));
}

function normalizeDocument(document) {
  if (!document) return document;
  const marker = document.__listStorage;
  if (marker && (marker.version !== 1 || marker.field !== "devices" || !marker.metadata))
    throw new Error("Unsupported LinkedDevices storage marker.");
  const result = { ...(marker ? marker.metadata : {}), ...document };
  delete result.__listStorage;
  const devices = { ...(document.devices || {}) };
  const updated = device => Math.max(Number(device.lastSeenAt) || 0,
    Number(device.linkedAt) || 0, Number(device.revokedAt) || 0);
  for (const [key, device] of flatDeviceEntries(document)) {
    const nested = devices[device.deviceId];
    // The complete newer record wins. On equal timestamps, prefer the canonical map.
    if (!nested || updated(device) > updated(nested)) devices[device.deviceId] = device;
    delete result[key];
  }
  result.devices = devices;
  return result;
}

async function read(accountId) {
  let document;
  try { document = await firestore.readDocument(COLLECTION, id(accountId), "/"); }
  catch (_error) { return null; }
  return normalizeDocument(document);
}

async function write(accountId, document) {
  const account = id(accountId);
  let raw;
  try { raw = await firestore.readDocument(COLLECTION, account, "/"); }
  catch (_error) { raw = null; }
  const body = withoutId(normalizeDocument(document));
  let result;
  if (raw) result = await firestore.updateDocument(COLLECTION, account, "/", { ...body });
  else result = await firestore.createDocument(COLLECTION, account, "/", { ...body });
  // Commit the canonical map before deleting duplicates. Failed cleanup remains retryable.
  for (const [key] of flatDeviceEntries(raw))
    await firestore.deleteField(COLLECTION, "/", account, key);
  if (raw && Object.hasOwn(raw, "__listStorage"))
    await firestore.deleteField(COLLECTION, "/", account, "__listStorage");
  return result;
}

async function linkDevice(accountId, input) {
  const account = id(accountId);
  return withAccountLock(account, async () => {
    const deviceId = text(input.deviceId);
    if (!account || !/^[A-Za-z0-9._:-]{8,128}$/.test(deviceId)) {
      throw Object.assign(new Error("A valid deviceId is required."), { statusCode: 400 });
    }
    const existing = await read(account);
    const devices = { ...((existing && existing.devices) || {}) };
    const active = Object.values(devices).filter((device) => device && !device.revokedAt && device.role === "companion");
    if ((!devices[deviceId] || devices[deviceId].revokedAt) && active.length >= MAX_DEVICES) {
      throw Object.assign(new Error("This account already has the maximum number of linked devices."),
        { statusCode: 409 });
    }
    const now = Date.now();
    const prior = devices[deviceId] || {};
    devices[deviceId] = {
      deviceId,
      name: text(input.name).slice(0, 100) || "Android device",
      platform: text(input.platform).slice(0, 30) || "android",
      role: "companion",
      linkedAt: prior.linkedAt || now,
      lastSeenAt: now,
      // Heartbeats and the Linked Devices screen register metadata without carrying the
      // Firebase token. Preserve the last uploaded token unless a new one is supplied.
      fcmToken: registeredFcmToken(input, prior),
      appVersion: text(input.appVersion).slice(0, 30),
      revokedAt: null,
    };
    await write(account, { accountId: account,
      version: Number(existing && existing.version || 0) + 1, updatedAt: now, devices });
    await UserDeviceInfo.registerDevice(account, devices[deviceId], { login: true });
    return devices[deviceId];
  });
}

async function registerDevice(accountId, input, options = {}) {
  if (input.role !== "companion")
    return UserDeviceInfo.registerDevice(accountId, { ...input, role: "primary" }, options);
  return withAccountLock(accountId, async () => {
    const document = await read(accountId);
    const prior = document?.devices?.[input.deviceId];
    if (!prior || prior.revokedAt || prior.role !== "companion")
      throw Object.assign(new Error("This device is not linked."), { statusCode: 401 });
    const device = { ...prior, lastSeenAt: Date.now(),
      name: text(input.name) || prior.name, platform: text(input.platform) || prior.platform,
      appVersion: text(input.appVersion) || prior.appVersion,
      fcmToken: registeredFcmToken(input, prior) };
    await write(accountId, { ...withoutId(document), devices: { ...document.devices, [input.deviceId]: device } });
    await UserDeviceInfo.registerDevice(accountId, device, options);
    return device;
  });
}

async function archiveDevice(accountId, device, reason, time) {
  let document;
  try { document = await firestore.readDocument("OldLinkedDevices", id(accountId), "/"); }
  catch (_error) { document = null; }
  const devices = { ...(document?.devices || {}) };
  const key = device.deviceId + ":" + (device.linkedAt || time);
  devices[key] = { ...device, fcmToken: "", revokedAt: time, unlinkedAt: time, unlinkReason: reason };
  const body = { accountId: id(accountId), updatedAt: time, devices };
  if (document) await firestore.updateDocument("OldLinkedDevices", id(accountId), "/", { ...body });
  else await firestore.createDocument("OldLinkedDevices", id(accountId), "/", { ...body });
}

async function listOldDevices(accountId) {
  let document;
  try { document = await firestore.readDocument("OldLinkedDevices", id(accountId), "/"); }
  catch (_error) { return []; }
  return Object.values(document?.devices || {}).sort((a,b) => Number(b.unlinkedAt || 0) - Number(a.unlinkedAt || 0));
}

async function listDevices(accountId) {
  const document = await read(accountId);
  return Object.values((document && document.devices) || {})
    .filter((device) => device && !device.revokedAt && device.role === "companion")
    .sort((a, b) => Number(a.linkedAt || 0) - Number(b.linkedAt || 0));
}

async function revokeDevice(accountId, deviceId) {
  const account = id(accountId);
  return withAccountLock(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    const normalizedDeviceId = text(deviceId);
    const existing = devices[normalizedDeviceId];
    if (!existing || existing.revokedAt || existing.role !== "companion") return false;
    const time = Date.now();
    await archiveDevice(account, existing, "device_unlinked", time);
    if (!await UserDeviceInfo.getDevice(account, normalizedDeviceId))
      await UserDeviceInfo.registerDevice(account, existing);
    await UserDeviceInfo.logoutDevice(account, normalizedDeviceId, "device_unlinked", time);
    delete devices[normalizedDeviceId];
    await write(account, { ...withoutId(document), accountId: account,
      version: Number(document && document.version || 0) + 1, updatedAt: Date.now(), devices });
    return true;
  });
}

async function revokeAllDevices(accountId) {
  const account = id(accountId);
  return withAccountLock(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    const revokedAt = Date.now();
    const notificationTokens = [...new Set(Object.values(devices)
      .filter((device) => device && !device.revokedAt)
      .map((device) => text(device.fcmToken)).filter(Boolean))];
    let revokedCount = 0;
    for (const deviceId of Object.keys(devices)) {
      const device = devices[deviceId];
      if (!device || device.revokedAt) continue;
      if (!await UserDeviceInfo.getDevice(account, deviceId))
        await UserDeviceInfo.registerDevice(account, device);
      if (device.role === "companion") {
        await archiveDevice(account, device, "account_logout", revokedAt);
        delete devices[deviceId];
      } else devices[deviceId] = { ...device, fcmToken: "", revokedAt };
      revokedCount += 1;
    }
    const loggedOut = await UserDeviceInfo.logoutAll(account, revokedAt);
    await write(account, { ...withoutId(document), accountId: account,
      sessionRevokedAt: revokedAt,
      version: Number(document && document.version || 0) + 1,
      updatedAt: revokedAt, devices });
    return { revokedAt, revokedCount: Math.max(revokedCount, loggedOut.revokedCount),
      notificationTokens: [...new Set([...notificationTokens, ...loggedOut.notificationTokens])] };
  });
}

async function getFcmTokens(accountId) {
  return [...new Set((await notificationDevices(accountId)).map((device) => text(device.fcmToken)).filter(Boolean))];
}

async function notificationDevices(accountId) {
  const known = await UserDeviceInfo.listDevices(accountId);
  const ids = new Set(known.map(device => device.deviceId));
  const legacy = Object.values((await read(accountId))?.devices || {}).filter(device => !ids.has(device.deviceId));
  return [...known, ...legacy].filter(device => !device.revokedAt && device.loggedIn !== false);
}

function registeredFcmToken(input, prior) {
  const supplied = text(input && input.fcmToken).slice(0, 4096);
  return supplied || text(prior && prior.fcmToken).slice(0, 4096);
}

function registeredDeviceRole(input, prior, active) {
  const supplied = text(input && input.role).toLowerCase();
  if (supplied === "primary" || supplied === "companion") return supplied;
  return text(prior && prior.role) || ((active || []).length === 0 ? "primary" : "companion");
}

async function getPrimaryFcmTokens(accountId) {
  return [...new Set((await notificationDevices(accountId))
    .filter((device) => device.role === "primary")
    .map((device) => text(device.fcmToken)).filter(Boolean))];
}

async function getFcmRegistration(accountId) {
  const document = await read(accountId);
  const devices = await notificationDevices(accountId);
  return { registryExists: Boolean(document) || await UserDeviceInfo.hasRegistry(accountId),
    tokens: [...new Set(devices.map((device) => text(device.fcmToken)).filter(Boolean))] };
}

async function isDeviceRevoked(accountId, deviceId) {
  const normalizedDeviceId = text(deviceId);
  if (!normalizedDeviceId) return false;
  const device = await getDevice(accountId, normalizedDeviceId);
  return Boolean(device && (device.revokedAt || device.loggedIn === false));
}

async function getDevice(accountId, deviceId) {
  const normalizedDeviceId = text(deviceId);
  if (!normalizedDeviceId) return null;
  const document = await read(accountId);
  const linked = document?.devices?.[normalizedDeviceId];
  const userDevice = await UserDeviceInfo.getDevice(accountId, normalizedDeviceId);
  if (userDevice?.loggedIn === false || userDevice?.revokedAt) return userDevice;
  return linked?.role === "companion" && !linked.revokedAt ? linked : userDevice || linked || null;
}

async function getSessionRevokedAt(accountId) {
  const document = await read(accountId);
  return Math.max(Number(document && document.sessionRevokedAt || 0), await UserDeviceInfo.getSessionRevokedAt(accountId));
}

async function touchDevice(accountId, deviceId) {
  const account = id(accountId);
  const normalizedDeviceId = text(deviceId);
  if (!normalizedDeviceId) return null;
  const registered = await getDevice(account, normalizedDeviceId);
  if (registered?.role === "primary") {
    if (registered.revokedAt || registered.loggedIn === false) return null;
    return UserDeviceInfo.registerDevice(account, registered);
  }
  return withAccountLock(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    const device = devices[normalizedDeviceId];
    if (!device || device.revokedAt) return null;
    devices[normalizedDeviceId] = { ...device, lastSeenAt: Date.now() };
    await write(account, { ...withoutId(document), accountId: account,
      updatedAt: Date.now(), devices });
    await UserDeviceInfo.registerDevice(account, devices[normalizedDeviceId]);
    return devices[normalizedDeviceId];
  });
}

async function withAccountLock(accountId, operation) {
  const key = id(accountId);
  const previous = accountLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  accountLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (accountLocks.get(key) === current) accountLocks.delete(key); }
}

module.exports = { MAX_DEVICES, linkDevice, registerDevice, listDevices, listOldDevices, revokeDevice,
  revokeAllDevices, getFcmTokens, getPrimaryFcmTokens, getFcmRegistration, getDevice,
  getSessionRevokedAt, isDeviceRevoked, touchDevice, registeredFcmToken,
  registeredDeviceRole };
