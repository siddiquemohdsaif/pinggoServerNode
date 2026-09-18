"use strict";

const crypto = require("crypto");
const LinkRequestStore = require("../models/LinkRequestStore");
const DeviceStore = require("../models/DeviceStore");
const AES = require("../utils/AES_256");
const FirestoreManager = require("../Firestore/FirestoreManager");

const LINK_TTL_MS = 2 * 60 * 1000;
const locks = new Map();

class DevicePairingService {
  constructor(options = {}) {
    this.requests = options.requests || LinkRequestStore;
    this.devices = options.devices || DeviceStore;
    this.now = options.now || Date.now.bind(Date);
    this.issueCredential = options.issueCredential
      || ((accountId, deviceId) => AES.getEncryptedCredential(accountId, `device:${deviceId}`));
    this.getUserData = options.getUserData
      || ((accountId) => FirestoreManager.getInstance().readDocument("Users", accountId, "/"));
  }

  async createLinkRequest(input = {}) {
    const deviceId = validDeviceId(input.deviceId);
    const deviceName = text(input.deviceName || input.name).slice(0, 100) || "Android device";
    const platform = text(input.platform).slice(0, 30) || "android";
    const publicKey = text(input.companionPublicKey).slice(0, 8192);
    const linkRequestId = crypto.randomUUID();
    const pairingSecret = crypto.randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + LINK_TTL_MS;
    await this.requests.create({ linkRequestId, secretHash: hash(pairingSecret), status: "pending",
      deviceId, deviceName, platform, companionPublicKey: publicKey,
      createdAt, expiresAt, approvedAt: null, completedAt: null });
    return { version: 1, linkRequestId, pairingSecret, companionPublicKey: publicKey,
      expiresAt };
  }

  async approve({ accountId, approvingDeviceId, linkRequestId, pairingSecret }) {
    return this.withLock(linkRequestId, async () => {
      const request = await this.requireAuthorizedRequest(linkRequestId, pairingSecret, "pending");
      const devices = await this.devices.listDevices(accountId);
      const alreadyLinked = devices.some((device) => device.deviceId === request.deviceId);
      if (!alreadyLinked && devices.length >= (this.devices.MAX_DEVICES || DeviceStore.MAX_DEVICES)) {
        throw failure(409, "This account already has the maximum number of linked devices.");
      }
      const accountSessionRevokedAt = this.devices.getSessionRevokedAt
        ? await this.devices.getSessionRevokedAt(accountId) : 0;
      const approved = { ...withoutId(request), accountId: account(accountId), status: "approved",
        accountSessionRevokedAt,
        approvedByDeviceId: text(approvingDeviceId), approvedAt: this.now() };
      await this.requests.write(linkRequestId, approved);
      return { status: "approved", linkRequestId, expiresAt: request.expiresAt };
    });
  }

  async status({ linkRequestId, pairingSecret }) {
    const request = await this.requireAuthorizedRequest(linkRequestId, pairingSecret);
    return { status: request.status, linkRequestId, expiresAt: request.expiresAt };
  }

  async complete({ linkRequestId, pairingSecret }) {
    return this.withLock(linkRequestId, async () => {
      const request = await this.requireAuthorizedRequest(linkRequestId, pairingSecret, "approved");
      const currentRevokedAt = this.devices.getSessionRevokedAt
        ? await this.devices.getSessionRevokedAt(request.accountId) : 0;
      if (currentRevokedAt > Number(request.accountSessionRevokedAt || 0)) {
        throw failure(409, "The primary account logged out after this code was approved.");
      }
      const device = await (this.devices.linkDevice || this.devices.registerDevice).call(this.devices, request.accountId, {
        deviceId: request.deviceId,
        name: request.deviceName,
        platform: request.platform,
        role: "companion",
      });
      const encryptedCredential = this.issueCredential(request.accountId, request.deviceId);
      let storedUserData = null;
      try { storedUserData = await this.getUserData(request.accountId); } catch (_error) {}
      const userData = companionUserData(storedUserData, request.accountId, encryptedCredential);
      await this.requests.write(linkRequestId, { ...withoutId(request), status: "completed",
        completedAt: this.now(), secretHash: hash(`consumed:${pairingSecret}`) });
      return { status: "completed", accountId: request.accountId, deviceId: request.deviceId,
        encryptedCredential, userData, device, syncRequired: true };
    });
  }

  async requireAuthorizedRequest(linkRequestId, pairingSecret, expectedStatus) {
    const requestId = text(linkRequestId);
    const secret = text(pairingSecret);
    if (!requestId || !secret) throw failure(400, "linkRequestId and pairingSecret are required.");
    const request = await this.requests.read(requestId);
    if (!request || !safeEqual(request.secretHash, hash(secret))) {
      throw failure(404, "Link request was not found.");
    }
    if (Number(request.expiresAt) <= this.now()) throw failure(410, "Link request has expired.");
    if (expectedStatus && request.status !== expectedStatus) {
      throw failure(409, request.status === "completed"
        ? "Link request has already been completed."
        : `Link request is ${request.status}.`);
    }
    return request;
  }

  async withLock(key, operation) {
    const requestId = text(key);
    const previous = locks.get(requestId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    locks.set(requestId, current);
    await previous;
    try { return await operation(); }
    finally { release(); if (locks.get(requestId) === current) locks.delete(requestId); }
  }
}

function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function safeEqual(left, right) {
  const a = Buffer.from(text(left)); const b = Buffer.from(text(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validDeviceId(value) {
  const result = text(value);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(result)) throw failure(400, "A valid deviceId is required.");
  return result;
}
function account(value) { return text(value).replace(/^<plus>/, "").replace(/^\+/, ""); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function withoutId(value) { const copy = { ...(value || {}) }; delete copy._id; return copy; }
function companionUserData(value, accountId, encryptedCredential) {
  const source = value && typeof value === "object" ? value : {};
  const sourceProfile = source.profileData && typeof source.profileData === "object"
    ? source.profileData : {};
  const id = account(accountId);
  const profileData = {
    name: text(sourceProfile.name || sourceProfile.displayName),
    phoneNumber: account(sourceProfile.phoneNumber || source.phoneNumber || id),
  };
  const email = text(sourceProfile.email).toLowerCase();
  const profilePhotoUrl = text(sourceProfile.profilePhotoUrl);
  if (email) profileData.email = email;
  if (profilePhotoUrl) profileData.profilePhotoUrl = profilePhotoUrl;
  return {
    _id: id,
    phoneNumber: account(source.phoneNumber || profileData.phoneNumber || id),
    profileData,
    encryptedCredential,
    createdAt: Number(source.createdAt || 0),
    lastSeen: Number(source.lastSeen || 0),
  };
}
function failure(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }

module.exports = { DevicePairingService, LINK_TTL_MS, companionUserData };
