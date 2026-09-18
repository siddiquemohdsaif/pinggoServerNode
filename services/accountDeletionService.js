"use strict";

const crypto = require("crypto");
const FirestoreManager = require("../Firestore/FirestoreManager");
const { chatEntries } = require("../utils/chatMembership");
const { revokeAllDevices } = require("../models/DeviceStore");
const { upsertShardedEntries } = require("../models/ShardedDocumentStore");
const { nextTimestamp } = require("../utils/timestampId");
const { forStorage } = require("../utils/messageTypes");
const { sendToUser } = require("../realtime/connectionManager");
const groupService = require("./groupService");
const UserModel = require("../models/UserModel");
const AES = require("../utils/AES_256");
const { generateP_ID, createP_ID_DOC } = require("../utils/signupUtils");
const { ensureAccountCollections } = require("../models/AccountStore");

const firestore = FirestoreManager.getInstance();
const DIRECT_COLLECTIONS = ["ChatsList", "CallsList", "UserBlocks", "LinkedDevices", "OldLinkedDevices", "UserDeviceInfo"];

function accountId(value) {
  return String(value || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");
}

function deletionId(value) {
  return crypto.createHash("sha256").update(accountId(value)).digest("hex");
}

async function readOrNull(collection, documentId) {
  try { return await firestore.readDocument(collection, documentId, "/"); }
  catch (_error) { return null; }
}

async function deleteIfPresent(collection, documentId) {
  if (!documentId || !await readOrNull(collection, documentId)) return;
  await firestore.deleteDocument(collection, documentId, "/");
}

async function writeDeletionMarker(id, directChats = [], user = null) {
  const markerId = deletionId(id);
  const profileData = { ...((user && user.profileData) || {}) };
  delete profileData.P_ID;
  delete profileData.localProfilePhotoPath;
  const value = { accountHash: markerId, deletedAt: Date.now(),
    directChats: directChats.filter((entry) => entry && entry.chatId && entry.peerId),
    profileData };
  try { await firestore.updateDocument("DeletedAccounts", markerId, "/", value); }
  catch (_error) { await firestore.createDocument("DeletedAccounts", markerId, "/", value); }
}

async function isAccountDeleted(id) {
  return Boolean(await readOrNull("DeletedAccounts", deletionId(id)));
}

async function beginReactivation(id) {
  const normalizedId = accountId(id);
  const markerId = deletionId(normalizedId);
  const marker = await readOrNull("DeletedAccounts", markerId);
  if (!marker) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  delete marker._id;
  marker.reactivationTokenHash = deletionId(token);
  marker.reactivationExpiresAt = Date.now() + 5 * 60 * 1000;
  await firestore.updateDocument("DeletedAccounts", markerId, "/", marker);
  return token;
}

async function reactivateAccount(id, token) {
  const normalizedId = accountId(id);
  const marker = await readOrNull("DeletedAccounts", deletionId(normalizedId));
  if (!marker || Number(marker.reactivationExpiresAt || 0) <= Date.now()
      || !safeEqual(marker.reactivationTokenHash, deletionId(token))) {
    const error = new Error("Reactivation confirmation is invalid or expired.");
    error.statusCode = 400;
    throw error;
  }
  const personalId = await generateP_ID();
  await createP_ID_DOC(personalId, normalizedId);
  const profileData = { ...(marker.profileData || {}), phoneNumber: normalizedId, P_ID: personalId };
  const user = new UserModel(normalizedId, profileData,
    AES.getEncryptedCredential(normalizedId, personalId));
  await firestore.createDocument("Users", normalizedId, "/", user);
  await ensureAccountCollections(normalizedId);
  await restoreAccount(normalizedId);
  return user;
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

async function restoreAccount(id) {
  const normalizedId = accountId(id);
  const markerId = deletionId(normalizedId);
  const marker = await readOrNull("DeletedAccounts", markerId);
  if (!marker) return;
  const directChats = marker.directChats || (marker.directContacts || []).map((peerId) => ({
    peerId: accountId(peerId), chatId: `${normalizedId}_${accountId(peerId)}`,
  }));
  for (const directChat of directChats) {
    const peerId = accountId(directChat.peerId);
    const chatId = String(directChat.chatId || "");
    const sentTime = nextTimestamp();
    const message = { id: String(sentTime), chatId, senderId: normalizedId,
      receiverId: accountId(peerId), text: "Account active again", messageType: "group_system",
      sentTime, status: "sent", systemEvent: { event: "account_recreated",
        actorId: normalizedId, targetIds: [normalizedId] }, receipts: {} };
    await upsertShardedEntries("Chats", chatId, { [message.id]: forStorage(message) });
    await updatePeerAccountState(peerId, chatId, message, true);
    sendToUser(peerId, { type: "account_recreated", userId: normalizedId, chatId,
      message: forStorage(message) }, sendSocketEvent);
  }
  await deleteIfPresent("DeletedAccounts", markerId);
}

async function isCurrentPrimaryCredential(id, credentialContext) {
  const user = await readOrNull("Users", accountId(id));
  const personalId = user && user.profileData && user.profileData.P_ID;
  return Boolean(personalId && String(personalId) === String(credentialContext || ""));
}

async function removeFromGroups(id) {
  const groupIds = await firestore.readCollectionDocumentIds("GroupsList", "/");
  for (const groupId of groupIds) {
    const group = await readOrNull("GroupsList", groupId);
    const member = group && group.members && group.members[id];
    if (member && member.status === "active") {
      const result = await groupService.removeDeletedAccount(groupId, id);
      if (result) result.memberIds.forEach((memberId) => sendToUser(memberId, {
        type: "account_deleted", chatId: groupId, userId: id,
      }, (socket, event) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(event));
      }));
    }
  }
}

function sendSocketEvent(socket, event) {
  if (socket.readyState === 1) socket.send(JSON.stringify(event));
}

async function updatePeerAccountState(peerId, chatId, message, active) {
  const document = await readOrNull("ChatsList", peerId);
  if (!document) return;
  const list = chatEntries(document);
  list[chatId] = { ...(list[chatId] || {}), last_message: forStorage(message),
    unread_count: Number(list[chatId] && list[chatId].unread_count || 0) + 1,
    account_active: active,
    profilePhotoUrl: null, profile_photo_url: null };
  delete document._id;
  await firestore.updateDocument("ChatsList", peerId, "/", { [chatId]: list[chatId] });
}

async function notifyDirectContacts(id, chatsList) {
  const chatIds = Object.keys(chatEntries(chatsList));
  for (const chatId of chatIds.filter((value) => !String(value).startsWith("grp_"))) {
    const peerId = String(chatId).split("_").map(accountId).find((value) => value && value !== id);
    if (!peerId) continue;
    const sentTime = nextTimestamp();
    const message = { id: String(sentTime), chatId, senderId: id, receiverId: peerId,
      text: "Deleted account", messageType: "group_system", sentTime, status: "sent",
      systemEvent: { event: "account_deleted", actorId: id, targetIds: [id] }, receipts: {} };
    await upsertShardedEntries("Chats", chatId, { [message.id]: forStorage(message) });
    await updatePeerAccountState(peerId, chatId, message, false);
    sendToUser(peerId, { type: "account_deleted", userId: id, chatId,
      message: forStorage(message) }, (socket, payload) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    });
  }
}

async function removeFromBlockLists(id) {
  const ownerIds = await firestore.readCollectionDocumentIds("UserBlocks", "/");
  for (const ownerId of ownerIds) {
    if (ownerId === id) continue;
    const document = await readOrNull("UserBlocks", ownerId);
    if (!document || !document.blockedUsers || !document.blockedUsers[id]) continue;
    delete document.blockedUsers[id]; delete document._id;
    await firestore.updateDocument("UserBlocks", ownerId, "/", document);
  }
}

async function deleteAccount(value) {
  const id = accountId(value);
  if (!id) throw new Error("Account id is required.");
  const user = await readOrNull("Users", id);
  if (!user) return { alreadyDeleted: true, revokedAt: Date.now(), notificationTokens: [] };

  const revoked = await revokeAllDevices(id);
  const chatsList = await readOrNull("ChatsList", id);
  await removeFromGroups(id);
  await notifyDirectContacts(id, chatsList);
  await removeFromBlockLists(id);
  const personalId = user.profileData && user.profileData.P_ID;
  if (personalId) await deleteIfPresent("P-ID-MAP", personalId);
  for (const collection of DIRECT_COLLECTIONS) await deleteIfPresent(collection, id);
  // Commit the deletion marker last so a failed cleanup remains retryable by the owner.
  const directChats = Object.keys(chatEntries(chatsList))
    .filter((chatId) => !chatId.startsWith("grp_"))
    .map((chatId) => ({ chatId, peerId: chatId.split("_").map(accountId)
      .find((participant) => participant && participant !== id) }))
    .filter((entry) => entry.peerId);
  await writeDeletionMarker(id, directChats, user);
  await deleteIfPresent("Users", id);
  return { alreadyDeleted: false, ...revoked };
}

module.exports = { accountId, beginReactivation, deleteAccount, isAccountDeleted,
  reactivateAccount, restoreAccount, isCurrentPrimaryCredential };
