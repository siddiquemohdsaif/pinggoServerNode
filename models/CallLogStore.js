const FirestoreManager = require("../Firestore/FirestoreManager");
const { callLogForStorage, callLogForClient } = require("../utils/specializedRecords");
const { readShardedMap, upsertShardedEntries } = require("./ShardedDocumentStore");

const firestore = FirestoreManager.getInstance();
const LIST_COLLECTION = "CallsList";
const LOG_COLLECTION = "CallLogs";

function normalizeId(value) {
  return String(value || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");
}

function withoutDocumentId(document) {
  const copy = { ...(document || {}) };
  delete copy._id;
  return copy;
}

async function readDocumentOrNull(collection, documentId) {
  try { return (await firestore.readDocument(collection, documentId, "/")) || null; }
  catch (_error) { return null; }
}

async function upsertDocument(collection, documentId, document, exists) {
  try {
    return exists
      ? await firestore.updateDocument(collection, documentId, "/", document)
      : await firestore.createDocument(collection, documentId, "/", document);
  } catch (_error) {
    return firestore.updateDocument(collection, documentId, "/", document);
  }
}

function normalizeList(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function buildLog(call) {
  const endedAt = Number(call.endedAt) || Date.now();
  return {
    callId: String(call.callId),
    messageId: String(call.messageId || ""),
    chatId: String(call.chatId || ""),
    callerId: normalizeId(call.callerId),
    receiverId: normalizeId(call.receiverId),
    mediaType: call.mediaType === "video" ? "video" : "audio",
    status: String(call.state || "ended"),
    terminationReason: String(call.terminationReason || "unknown"),
    createdAt: Number(call.createdAt) || endedAt,
    ringingAt: Number(call.ringingAt) || null,
    connectedAt: Number(call.connectedAt) || null,
    endedAt,
    durationSeconds: call.connectedAt
      ? Math.max(0, Math.floor((endedAt - Number(call.connectedAt)) / 1000)) : 0,
  };
}

async function updateCallsList(userId, otherUserId, log) {
  const existing = await readDocumentOrNull(LIST_COLLECTION, userId);
  const list = normalizeList(existing && existing.list);
  const current = list[log.chatId];
  const currentEndedAt = Number(current && current.lastCall && current.lastCall.endedAt) || 0;
  if (currentEndedAt > log.endedAt) return;
  await upsertDocument(LIST_COLLECTION, userId, {
    ...withoutDocumentId(existing),
    list: { ...list, [log.chatId]: {
      chatId: log.chatId, otherUserId, lastCall: callLogForStorage(log),
    } },
  }, Boolean(existing));
}

async function saveCallLog(call) {
  if (!call || !call.callId) throw new Error("callId is required.");
  const log = buildLog(call);
  if (!log.chatId) throw new Error("chatId is required.");
  if (!log.callerId || !log.receiverId) throw new Error("Call participants are required.");
  await upsertShardedEntries(LOG_COLLECTION, log.chatId, {
    [log.callId]: callLogForStorage(log),
  }, "calls");
  await Promise.all([
    updateCallsList(log.callerId, log.receiverId, log),
    updateCallsList(log.receiverId, log.callerId, log),
  ]);
  return log;
}

function pageCalls(values, pageSize, cursor, keyField) {
  const limit = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  let start = 0;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
      start = values.findIndex((value) =>
        (Number(value.endedAt) || Number(value.createdAt) || 0) < Number(decoded.time)
        || ((Number(value.endedAt) || Number(value.createdAt) || 0) === Number(decoded.time)
          && String(value[keyField] || "") > String(decoded.key || "")));
      if (start < 0) start = values.length;
    } catch (_error) {
      const error = new Error("cursor is invalid.");
      error.statusCode = 400;
      throw error;
    }
  }
  const calls = values.slice(start, start + limit);
  const hasMore = start + calls.length < values.length;
  const last = calls[calls.length - 1];
  return {
    calls,
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({
      time: Number(last.endedAt) || Number(last.createdAt) || 0,
      key: String(last[keyField] || ""),
    }), "utf8").toString("base64url") : null,
  };
}

async function getCallsList(userId, pageSize, cursor) {
  const id = normalizeId(userId);
  if (!id) return { calls: [], hasMore: false, nextCursor: null };
  const document = await readDocumentOrNull(LIST_COLLECTION, id);
  const values = Object.entries(normalizeList(document && document.list))
    .map(([chatId, entry]) => ({
      ...callLogForClient(entry && entry.lastCall ? entry.lastCall : entry),
      chatId,
      otherUserId: normalizeId(entry && entry.otherUserId),
    }))
    .sort((a, b) => (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0)
      || String(a.chatId).localeCompare(String(b.chatId)));
  return pageCalls(values, pageSize, cursor, "chatId");
}

async function getCallLogs(userId, chatId, pageSize, cursor) {
  const id = normalizeId(userId);
  const normalizedChatId = String(chatId || "").trim();
  if (!id || !normalizedChatId) return { calls: [], hasMore: false, nextCursor: null };
  if (!normalizedChatId.split("_").map(normalizeId).includes(id)) {
    const error = new Error("phoneNumber must be a participant in chatId.");
    error.statusCode = 403;
    throw error;
  }
  const document = await readShardedMap(LOG_COLLECTION, normalizedChatId, "calls");
  const values = Object.entries(document || {})
    .filter(([key, value]) => key !== "_id" && value && typeof value === "object")
    .map(([, value]) => callLogForClient(value))
    .sort((a, b) => (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0)
      || String(a.callId).localeCompare(String(b.callId)));
  return pageCalls(values, pageSize, cursor, "callId");
}

module.exports = { getCallsList, getCallLogs, saveCallLog };
