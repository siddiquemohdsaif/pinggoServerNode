const FirestoreManager = require("../Firestore/FirestoreManager");
const { callLogForStorage, callLogForClient } = require("../utils/specializedRecords");
const { readShardedMap, upsertShardedEntries } = require("./ShardedDocumentStore");

const firestore = FirestoreManager.getInstance();
const LIST_COLLECTION = "CallsList";
const LOG_COLLECTION = "CallLogs";

function normalizeId(value) {
  return String(value || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");
}

async function readDocumentOrNull(collection, documentId) {
  try { return (await firestore.readDocument(collection, documentId, "/")) || null; }
  catch (_error) { return null; }
}

function normalizeList(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function buildLog(call) {
  const endedAt = Number(call.endedAt) || Date.now();
  const participantIds = Array.isArray(call.historyParticipantIds || call.participantIds)
    ? [...new Set((call.historyParticipantIds || call.participantIds)
      .map(normalizeId).filter(Boolean))] : [];
  const participantDurationsSeconds = {};
  for (const userId of participantIds) {
    const joinedAt = Number(call.participantJoinedAt && call.participantJoinedAt[userId]);
    const leftAt = Number(call.participantLeftAt && call.participantLeftAt[userId]) || endedAt;
    participantDurationsSeconds[userId] = joinedAt
      ? Math.max(0, Math.floor((leftAt - joinedAt) / 1000)) : 0;
  }
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
    groupCall: String(call.chatId || "").startsWith("grp_"),
    conference: Boolean(call.conference || String(call.chatId || "").startsWith("grp_")
      || (Array.isArray(call.participantIds) && call.participantIds.length > 2)),
    participantIds,
    participantDurationsSeconds,
  };
}

async function saveCallLog(call) {
  if (!call || !call.callId) throw new Error("callId is required.");
  const log = buildLog(call);
  if (!log.chatId) throw new Error("chatId is required.");
  if (!log.callerId || (!log.receiverId && !log.conference))
    throw new Error("Call participants are required.");
  const participants = log.participantIds.length
    ? log.participantIds : [log.callerId, log.receiverId].filter(Boolean);
  await Promise.all(participants.map((userId) => upsertShardedEntries(
    LOG_COLLECTION, userId, { [log.callId]: callLogForStorage({
      ...log, durationSeconds:
        log.participantDurationsSeconds[userId] ?? log.durationSeconds,
    }) }, "calls")));
  return log;
}

async function readUserTimeline(userId) {
  const timeline = await readShardedMap(LOG_COLLECTION, userId, "calls");
  const merged = new Map(Object.entries(timeline || {})
    .filter(([key, value]) => key !== "_id" && value && typeof value === "object"));

  // CallsList is only a migration index now. Use its chat ids to discover historical logs,
  // merge them into the per-user timeline, and backfill the new store on first read.
  const legacyList = await readDocumentOrNull(LIST_COLLECTION, userId);
  const chatIds = Object.keys(normalizeList(legacyList && legacyList.list));
  const legacyDocuments = await Promise.all(chatIds.map((chatId) =>
    readShardedMap(LOG_COLLECTION, chatId, "calls")));
  const backfill = {};
  for (const document of legacyDocuments) {
    for (const [callId, value] of Object.entries(document || {})) {
      if (callId === "_id" || !value || typeof value !== "object" || merged.has(callId)) continue;
      const log = callLogForClient(value);
      const participants = Array.isArray(log.participantIds) && log.participantIds.length
        ? log.participantIds.map(normalizeId) : [normalizeId(log.callerId), normalizeId(log.receiverId)];
      if (!participants.includes(userId)) continue;
      const userLog = { ...log, durationSeconds:
        log.participantDurationsSeconds?.[userId] ?? log.durationSeconds };
      merged.set(callId, callLogForStorage(userLog));
      backfill[callId] = callLogForStorage(userLog);
    }
  }
  if (Object.keys(backfill).length) {
    await upsertShardedEntries(LOG_COLLECTION, userId, backfill, "calls");
  }
  return merged;
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
  const document = await readUserTimeline(id);
  const values = [...document.values()]
    .map((value) => callLogForClient(value))
    .sort((a, b) => (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0)
      || String(a.callId).localeCompare(String(b.callId)));
  return pageCalls(values, pageSize, cursor, "callId");
}

async function getCallLogs(userId, chatId, pageSize, cursor) {
  const id = normalizeId(userId);
  const normalizedChatId = String(chatId || "").trim();
  if (!id || !normalizedChatId) return { calls: [], hasMore: false, nextCursor: null };
  const document = await readUserTimeline(id);
  const values = [...document.values()]
    .map((value) => {
      const log = callLogForClient(value);
      return { ...log, durationSeconds:
        log.participantDurationsSeconds?.[id] ?? log.durationSeconds };
    })
    .filter((log) => log.chatId === normalizedChatId)
    .sort((a, b) => (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0)
      || String(a.callId).localeCompare(String(b.callId)));
  return pageCalls(values, pageSize, cursor, "callId");
}

module.exports = { getCallsList, getCallLogs, saveCallLog };
