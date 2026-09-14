"use strict";

require("dotenv").config();

const FirestoreManager = require("../Firestore/FirestoreManager");
const { deleteFile } = require("../utils/fileStorage");
const { deleteShardCollections, readShardedMap } = require("../models/ShardedDocumentStore");

const firestoreManager = FirestoreManager.getInstance();
const DEMO_GENERATOR = "test/test1.js";

// Add specific test accounts here when they must be removed even if they were
// created before test1 started marking generated accounts. Never add real users.
const PHONE_NUMBERS_TO_DELETE = Object.freeze([
  "923762276510"
]);

function withoutId(document) {
  if (!document || typeof document !== "object") return {};
  const copy = { ...document };
  delete copy._id;
  return copy;
}

function chatIdFromListItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.chatId || item.id || item._id || "";
}

function chatParticipants(chatId) {
  return String(chatId || "").split("_").filter(Boolean);
}

async function readDocumentOrNull(collection, documentId) {
  try {
    return (await firestoreManager.readDocument(collection, documentId, "/")) || null;
  } catch (_error) {
    return null;
  }
}

async function deleteDocumentIfPresent(collection, documentId) {
  if (!(await readDocumentOrNull(collection, documentId))) return false;
  await firestoreManager.deleteDocument(collection, documentId, "/");
  return true;
}

async function findDemoPhoneNumbers() {
  const discovered = new Set(PHONE_NUMBERS_TO_DELETE);
  const userIds = await firestoreManager.readCollectionDocumentIds("Users", "/");
  for (const userId of userIds) {
    const user = await readDocumentOrNull("Users", userId);
    if (user && user.profileData
        && user.profileData.demoGeneratedBy === DEMO_GENERATOR) {
      discovered.add(String(userId));
    }
  }
  return [...discovered];
}

async function removeChatFromParticipant(chatId, phoneNumber, deletedUsers) {
  if (deletedUsers.has(phoneNumber)) return;

  const chatsList = await readDocumentOrNull("ChatsList", phoneNumber);
  if (!chatsList || !chatsList.list) return;

  let filteredList;
  if (Array.isArray(chatsList.list)) {
    filteredList = chatsList.list.filter(
      (item) => chatIdFromListItem(item) !== chatId,
    );
    if (filteredList.length === chatsList.list.length) return;
  } else if (typeof chatsList.list === "object") {
    if (!Object.prototype.hasOwnProperty.call(chatsList.list, chatId)) return;
    filteredList = { ...chatsList.list };
    delete filteredList[chatId];
  } else {
    return;
  }

  await firestoreManager.updateDocument("ChatsList", phoneNumber, "/", {
    ...withoutId(chatsList),
    list: filteredList,
  });
}

async function findAllDemoChatIds(demoPhoneNumbers) {
  const chatIds = new Set();

  for (const phoneNumber of demoPhoneNumbers) {
    const chatsList = await readDocumentOrNull("ChatsList", phoneNumber);
    const storedList = chatsList && chatsList.list;
    const list = Array.isArray(storedList)
      ? storedList
      : storedList && typeof storedList === "object"
        ? Object.keys(storedList)
        : [];
    for (const item of list) {
      const chatId = chatIdFromListItem(item);
      if (chatId) chatIds.add(chatId);
    }
  }

  // Also catches a chat whose demo user's ChatsList document is already missing.
  const allChatIds = await firestoreManager.readCollectionDocumentIds("Chats", "/");
  for (const chatId of allChatIds) {
    if (chatParticipants(chatId).some((id) => demoPhoneNumbers.includes(id))) {
      chatIds.add(chatId);
    }
  }

  return chatIds;
}

async function deleteMatchingAttachments(chatIds, demoPhoneNumbers) {
  let deletedCount = 0;

  // Current schema: one root per chat with attachment-id fields in MessageBatches.
  for (const chatId of chatIds) {
    const collection = String(chatId).startsWith("grp_")
      ? "GroupAttachments" : "ChatAttachments";
    const attachments = await readShardedMap(collection, chatId, "attachments");
    for (const attachment of Object.values(attachments || {})) {
      if (attachment && attachment.fullPath) await deleteFile(attachment.fullPath);
      deletedCount += 1;
    }
    await deleteShardCollections(collection, chatId);
    await deleteDocumentIfPresent(collection, chatId);
  }

  // Previous flat schema: retain cleanup support until all environments migrate.
  for (const collection of ["ChatAttachments", "GroupAttachments"]) {
    const attachmentIds = await firestoreManager.readCollectionDocumentIds(collection, "/");
    for (const attachmentId of attachmentIds) {
      const attachment = await readDocumentOrNull(collection, attachmentId);
      if (!attachment || !attachment.chatId) continue;

      const belongsToCleanup = chatIds.has(attachment.chatId)
        || demoPhoneNumbers.includes(String(attachment.uploaderId || ""));
      if (!belongsToCleanup) continue;

      if (attachment.fullPath) await deleteFile(attachment.fullPath);
      await firestoreManager.deleteDocument(collection, attachmentId, "/");
      deletedCount += 1;
    }
  }

  return deletedCount;
}

async function deleteDemoUser(phoneNumber) {
  const user = await readDocumentOrNull("Users", phoneNumber);
  const pId = user && user.profileData && user.profileData.P_ID;
  const profilePhotoUrl = user && user.profileData && user.profileData.profilePhotoUrl;
  const profilePath = managedFilePath(profilePhotoUrl);

  await deleteShardCollections("CallLogs", phoneNumber);

  const deleted = {
    phoneNumber,
    user: await deleteDocumentIfPresent("Users", phoneNumber),
    chatsList: await deleteDocumentIfPresent("ChatsList", phoneNumber),
    callLogs: await deleteDocumentIfPresent("CallLogs", phoneNumber),
    profileFile: profilePath ? Boolean(await deleteFile(profilePath)) : false,
    pId: false,
  };

  if (pId) {
    deleted.pId = await deleteDocumentIfPresent("P-ID-MAP", pId);
  }

  return deleted;
}

function managedFilePath(value) {
  const marker = "/files/";
  const text = String(value || "");
  const index = text.indexOf(marker);
  if (index < 0) return "";
  try { return decodeURIComponent(text.slice(index + marker.length).split(/[?#]/)[0]); }
  catch (_error) { return ""; }
}

async function removeMatchingCallLogs(accountId, chatIds) {
  const parent = `/CallLogs/${accountId}`;
  const batchIds = await firestoreManager.readCollectionDocumentIds("CallBatches", parent)
    .catch(() => []);
  let removed = 0;
  for (const batchId of batchIds) {
    const batch = await firestoreManager.readDocument("CallBatches", batchId, parent)
      .catch(() => null);
    for (const [callId, log] of Object.entries(batch || {})) {
      if (callId === "_id" || !log || !chatIds.has(String(log.chatId || ""))) continue;
      await firestoreManager.deleteField("CallBatches", parent, batchId, callId);
      removed += 1;
    }
  }
  return removed;
}

async function startExecution() {
  const demoPhoneNumbers = await findDemoPhoneNumbers();
  const deletedUsers = new Set(demoPhoneNumbers);
  const chatIds = await findAllDemoChatIds(demoPhoneNumbers);

  console.log(`Found ${chatIds.size} chat(s) belonging to the demo users.`);

  // Remove each deleted chat from every non-demo participant before deleting it.
  for (const chatId of chatIds) {
    for (const participant of chatParticipants(chatId)) {
      await removeChatFromParticipant(chatId, participant, deletedUsers);
    }
  }

  const deletedAttachments = await deleteMatchingAttachments(chatIds, demoPhoneNumbers);

  const remainingParticipants = new Set([...chatIds]
    .flatMap((chatId) => chatParticipants(chatId))
    .filter((participant) => !deletedUsers.has(participant)));
  let deletedPeerCallLogs = 0;
  for (const participant of remainingParticipants) {
    deletedPeerCallLogs += await removeMatchingCallLogs(participant, chatIds);
  }

  let deletedChats = 0;
  for (const chatId of chatIds) {
    await deleteShardCollections("Chats", chatId);
    if (await deleteDocumentIfPresent("Chats", chatId)) deletedChats += 1;
  }

  const users = [];
  for (let index = 0; index < demoPhoneNumbers.length; index += 1) {
    const phoneNumber = demoPhoneNumbers[index];
    const result = await deleteDemoUser(phoneNumber);
    users.push(result);
    console.log(
      `[${index + 1}/${demoPhoneNumbers.length}] ${phoneNumber}` +
        ` -> user=${result.user}, chatList=${result.chatsList}, callLogs=${result.callLogs}, pId=${result.pId}`,
    );
  }

  const summary = {
    requestedUsers: demoPhoneNumbers.length,
    deletedChats,
    deletedAttachments,
    deletedPeerCallLogs,
    users,
  };
  console.log("Cleanup completed:", JSON.stringify(summary, null, 2));
  return summary;
}

module.exports = { PHONE_NUMBERS_TO_DELETE, startExecution };

if (require.main === module) {
  startExecution().catch((error) => {
    console.error("Cleanup failed:", error.message);
    process.exitCode = 1;
  });
}
