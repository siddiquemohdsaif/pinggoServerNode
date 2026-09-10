"use strict";

const FirestoreManager = require("../Firestore/FirestoreManager");
const firestore = FirestoreManager.getInstance();
const COLLECTION = "LinkedDevices";
const MAX_DEVICES = 5; // one primary plus four companions
const accountLocks = new Map();

function id(value) {
  return typeof value === "string" ? value.trim().replace(/^<plus>/, "").replace(/^\+/, "") : "";
}
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function withoutId(value) { const copy = { ...(value || {}) }; delete copy._id; return copy; }

async function read(accountId) {
  try { return await firestore.readDocument(COLLECTION, id(accountId), "/"); }
  catch (_error) { return null; }
}

async function write(accountId, document) {
  const account = id(accountId);
  const body = withoutId(document);
  try { return await firestore.updateDocument(COLLECTION, account, "/", body); }
  catch (_error) { return firestore.createDocument(COLLECTION, account, "/", withoutId(document)); }
}

async function registerDevice(accountId, input) {
  const account = id(accountId);
  return withAccountLock(account, async () => {
    const deviceId = text(input.deviceId);
    if (!account || !/^[A-Za-z0-9._:-]{8,128}$/.test(deviceId)) {
      throw Object.assign(new Error("A valid deviceId is required."), { statusCode: 400 });
    }
    const existing = await read(account);
    const devices = { ...((existing && existing.devices) || {}) };
    const active = Object.values(devices).filter((device) => device && !device.revokedAt);
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
      role: registeredDeviceRole(input, prior, active),
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
    return devices[deviceId];
  });
}

async function listDevices(accountId) {
  const document = await read(accountId);
  return Object.values((document && document.devices) || {})
    .filter((device) => device && !device.revokedAt)
    .sort((a, b) => Number(a.linkedAt || 0) - Number(b.linkedAt || 0));
}

async function revokeDevice(accountId, deviceId) {
  const account = id(accountId);
  return withAccountLock(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    const normalizedDeviceId = text(deviceId);
    const existing = devices[normalizedDeviceId];
    if (!existing || existing.revokedAt) return false;
    devices[normalizedDeviceId] = { ...existing, fcmToken: "", revokedAt: Date.now() };
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
    Object.keys(devices).forEach((deviceId) => {
      const device = devices[deviceId];
      if (!device || device.revokedAt) return;
      devices[deviceId] = { ...device, fcmToken: "", revokedAt };
      revokedCount += 1;
    });
    await write(account, { ...withoutId(document), accountId: account,
      sessionRevokedAt: revokedAt,
      version: Number(document && document.version || 0) + 1,
      updatedAt: revokedAt, devices });
    return { revokedAt, revokedCount, notificationTokens };
  });
}

async function getFcmTokens(accountId) {
  return [...new Set((await listDevices(accountId)).map((device) => text(device.fcmToken)).filter(Boolean))];
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
  return [...new Set((await listDevices(accountId))
    .filter((device) => device.role === "primary")
    .map((device) => text(device.fcmToken)).filter(Boolean))];
}

async function getFcmRegistration(accountId) {
  const document = await read(accountId);
  const devices = Object.values((document && document.devices) || {})
    .filter((device) => device && !device.revokedAt);
  return { registryExists: Boolean(document),
    tokens: [...new Set(devices.map((device) => text(device.fcmToken)).filter(Boolean))] };
}

async function isDeviceRevoked(accountId, deviceId) {
  const normalizedDeviceId = text(deviceId);
  if (!normalizedDeviceId) return false;
  const document = await read(accountId);
  const device = document && document.devices && document.devices[normalizedDeviceId];
  return Boolean(device && device.revokedAt);
}

async function getDevice(accountId, deviceId) {
  const normalizedDeviceId = text(deviceId);
  if (!normalizedDeviceId) return null;
  const document = await read(accountId);
  return document && document.devices ? document.devices[normalizedDeviceId] || null : null;
}

async function getSessionRevokedAt(accountId) {
  const document = await read(accountId);
  return Number(document && document.sessionRevokedAt || 0);
}

async function touchDevice(accountId, deviceId) {
  const account = id(accountId);
  const normalizedDeviceId = text(deviceId);
  if (!normalizedDeviceId) return null;
  return withAccountLock(account, async () => {
    const document = await read(account);
    const devices = { ...((document && document.devices) || {}) };
    const device = devices[normalizedDeviceId];
    if (!device || device.revokedAt) return null;
    devices[normalizedDeviceId] = { ...device, lastSeenAt: Date.now() };
    await write(account, { ...withoutId(document), accountId: account,
      updatedAt: Date.now(), devices });
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

module.exports = { MAX_DEVICES, registerDevice, listDevices, revokeDevice,
  revokeAllDevices, getFcmTokens, getPrimaryFcmTokens, getFcmRegistration, getDevice,
  getSessionRevokedAt, isDeviceRevoked, touchDevice, registeredFcmToken,
  registeredDeviceRole };
