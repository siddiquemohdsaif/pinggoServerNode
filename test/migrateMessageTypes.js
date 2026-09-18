const FirestoreManager = require("../Firestore/FirestoreManager");
const { chatEntries } = require("../utils/chatMembership");
const { callLogForStorage, reportForStorage } = require("../utils/specializedRecords");
const { forStorage, forClient } = require("../utils/messageTypes");

const firestore = FirestoreManager.getInstance();
const EXECUTE = process.argv.includes("--execute");

// Legacy string -> latest numeric message type.
// 0 text, 1 image, 2 video, 3 audio, 4 file, 5 location,
// 6 voice_call, 7 video_call, 8 report, 9 chat_report,
// 10 chat_block, 11 chat_unblock.
const TYPE_CODES = Object.freeze({
  text: 0,
  image: 1,
  video: 2,
  audio: 3,
  file: 4,
  location: 5,
  voice_call: 6,
  video_call: 7,
  report: 8,
  chat_report: 9,
  chat_block: 10,
  chat_unblock: 11,
});
const VALID_CODES = new Set(Object.values(TYPE_CODES));

function inferLegacyType(message, path) {
  if (!message || typeof message !== "object") {
    throw new Error(`${path}: cannot infer messageType from a non-object record`);
  }
  const attachment = message.attachment;
  if (attachment && typeof attachment === "object") {
    const kind = String(attachment.kind || "").trim().toLowerCase();
    if (["image", "video", "audio", "file"].includes(kind)) return kind;
    const mime = String(attachment.mimeType || attachment.mime || "").trim().toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime && mime !== "application/octet-stream") return "file";
    const name = String(attachment.name || attachment.fileName || "").trim().toLowerCase();
    if (/\.(jpe?g|png|gif|webp|bmp|heic|heif)$/.test(name)) return "image";
    if (/\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/.test(name)) return "video";
    if (/\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(name)) return "audio";
    if (name) return "file";
    throw new Error(`${path}: attachment has no usable kind, MIME type, or filename`);
  }
  if (message.location && typeof message.location === "object") return "location";
  if (message.callId || message.callDurationSeconds != null
      || message.callTerminationReason != null) {
    const media = String(message.mediaType || "").trim().toLowerCase();
    if (media === "video" || message.receiverText?.toLowerCase().includes("video")) {
      return "video_call";
    }
    return "voice_call";
  }
  if (message.reportReason != null) return "chat_report";
  if (message.blocked === true) return "chat_block";
  if (message.blocked === false) return "chat_unblock";
  // Old ordinary text messages did not always contain messageType. This rule exists only
  // in the one-time migration; current Android/server runtime parsing remains strict.
  if (typeof message.text === "string") return "text";
  throw new Error(`${path}: cannot infer missing messageType from record structure`);
}

function convertType(value, path, message, summary) {
  if (Number.isInteger(value) && VALID_CODES.has(value)) {
    return { value, changed: false, name: Object.keys(TYPE_CODES)[value] };
  }
  if (value == null || value === "") {
    const inferred = inferLegacyType(message, path);
    summary.inferredTypes[inferred]++;
    return { value: TYPE_CODES[inferred], changed: true, name: inferred };
  }
  if (typeof value !== "string") {
    throw new Error(`${path}: invalid messageType (${String(value)})`);
  }
  const name = value.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TYPE_CODES, name)) {
    throw new Error(`${path}: unknown legacy messageType '${value}'`);
  }
  return { value: TYPE_CODES[name], changed: true, name };
}

function withoutDocumentId(document) {
  const copy = { ...(document || {}) };
  delete copy._id;
  return copy;
}

function increment(counts, name) {
  counts[name] = (counts[name] || 0) + 1;
}

async function migrateChats(summary) {
  const chatIds = await firestore.readCollectionDocumentIds("Chats", "/");
  for (const chatId of chatIds) {
    const document = await firestore.readDocument("Chats", chatId, "/");
    const updates = {};
    for (const [messageId, message] of Object.entries(document || {})) {
      if (messageId === "_id" || !message || typeof message !== "object") continue;
      const converted = convertType(message.t ?? message.messageType,
        `Chats/${chatId}/${messageId}`, message, summary);
      increment(summary.byType, converted.name);
      summary.messagesScanned++;
      if (Object.prototype.hasOwnProperty.call(message, "t")) {
        updates[messageId] = forStorage(forClient(message));
        summary.messagesChanged++;
      } else if (converted.changed) {
        updates[messageId] = forStorage({ ...message, messageType: converted.value });
        summary.messagesChanged++;
      }
    }
    if (EXECUTE && Object.keys(updates).length > 0) {
      await firestore.updateDocument("Chats", chatId, "/", updates);
      summary.chatDocumentsChanged++;
    }
  }
}

async function migrateChatsList(summary) {
  const accountIds = await firestore.readCollectionDocumentIds("ChatsList", "/");
  for (const accountId of accountIds) {
    const document = await firestore.readDocument("ChatsList", accountId, "/");
    const list = chatEntries(document);
    let changed = false;
    for (const [chatId, originalSettings] of Object.entries(list)) {
      if (!originalSettings || typeof originalSettings !== "object"
          || !originalSettings.last_message) continue;
      const settings = { ...originalSettings };
      const lastMessage = { ...settings.last_message };
      const converted = convertType(
        lastMessage.t ?? lastMessage.messageType,
        `ChatsList/${accountId}/${chatId}/last_message`,
        lastMessage,
        summary,
      );
      summary.lastMessagesScanned++;
      if (Object.prototype.hasOwnProperty.call(lastMessage, "t")) {
        settings.last_message = forStorage(forClient(lastMessage));
        list[chatId] = settings;
        summary.lastMessagesChanged++;
        changed = true;
      } else if (converted.changed) {
        lastMessage.messageType = converted.value;
        settings.last_message = forStorage(lastMessage);
        list[chatId] = settings;
        summary.lastMessagesChanged++;
        changed = true;
      }
    }
    if (EXECUTE && changed) {
      await firestore.updateDocument("ChatsList", accountId, "/", {
        ...list,
      });
      summary.chatListDocumentsChanged++;
    }
  }
}

async function migrateCallLogs(summary) {
  const accountIds = await firestore.readCollectionDocumentIds("CallLogs", "/");
  for (const accountId of accountIds) {
    const document = await firestore.readDocument("CallLogs", accountId, "/");
    const updates = {};
    for (const [callId, log] of Object.entries(document || {})) {
      if (callId === "_id" || !log || typeof log !== "object") continue;
      summary.callLogsScanned++;
      if (!Object.prototype.hasOwnProperty.call(log, "call")) continue;
      updates[callId] = callLogForStorage(log);
      summary.callLogsChanged++;
    }
    if (EXECUTE && Object.keys(updates).length > 0) {
      await firestore.updateDocument("CallLogs", accountId, "/", updates);
      summary.callLogDocumentsChanged++;
    }
  }
}

async function migrateReports(summary) {
  const chatIds = await firestore.readCollectionDocumentIds("Reports", "/");
  for (const chatId of chatIds) {
    const document = await firestore.readDocument("Reports", chatId, "/");
    summary.reportDocumentsScanned++;
    if (!document || (!Array.isArray(document.messages) && !Array.isArray(document.m))) {
      throw new Error(`Reports/${chatId}: invalid report document`);
    }
    if (!Object.prototype.hasOwnProperty.call(document, "c")) continue;
    const expanded = reportForStorage(document);
    summary.reportItemsChanged += expanded.messages.length;
    summary.reportDocumentsChanged++;
    if (EXECUTE) {
      await firestore.deleteDocument("Reports", chatId, "/");
      await firestore.createDocument("Reports", chatId, "/", expanded);
    }
  }
}

async function main() {
  const summary = {
    messagesScanned: 0,
    messagesChanged: 0,
    chatDocumentsChanged: 0,
    lastMessagesScanned: 0,
    lastMessagesChanged: 0,
    chatListDocumentsChanged: 0,
    callLogsScanned: 0,
    callLogsChanged: 0,
    callLogDocumentsChanged: 0,
    reportDocumentsScanned: 0,
    reportDocumentsChanged: 0,
    reportItemsChanged: 0,
    byType: Object.fromEntries(Object.keys(TYPE_CODES).map((name) => [name, 0])),
    inferredTypes: Object.fromEntries(Object.keys(TYPE_CODES).map((name) => [name, 0])),
  };

  console.log(`Message type migration mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  await migrateChats(summary);
  await migrateChatsList(summary);
  await migrateCallLogs(summary);
  await migrateReports(summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!EXECUTE) {
    console.log("No data was changed. Run with --execute to apply the migration.");
  }
}

main().catch((error) => {
  console.error("Message type migration failed:", error);
  process.exitCode = 1;
});
