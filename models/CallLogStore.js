const FirestoreManager = require("../Firestore/FirestoreManager");
const { callLogForStorage, callLogForClient } = require("../utils/specializedRecords");

const firestore = FirestoreManager.getInstance();
const COLLECTION = "CallLogs";

function normalizeId(value) {
  return String(value || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");
}

async function saveCallLog(call) {
  if (!call || !call.callId) throw new Error("callId is required.");
  const callerId = normalizeId(call.callerId);
  const receiverId = normalizeId(call.receiverId);
  if (!callerId || !receiverId) throw new Error("Call participants are required.");
  const endedAt = Number(call.endedAt) || Date.now();
  const log = {
    callId: String(call.callId),
    chatId: String(call.chatId || ""),
    callerId,
    receiverId,
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
  const storedLog = callLogForStorage(log);
  await Promise.all([callerId, receiverId].map(async (userId) => {
    try {
      await firestore.updateDocument(COLLECTION, userId, "/", { [log.callId]: storedLog });
    } catch (_error) {
      try {
        await firestore.createDocument(COLLECTION, userId, "/", { [log.callId]: storedLog });
      } catch (_createError) {
        await firestore.updateDocument(COLLECTION, userId, "/", { [log.callId]: storedLog });
      }
    }
  }));
  return log;
}

async function getCallLogs(userId) {
  const id = normalizeId(userId);
  if (!id) return [];
  let doc;
  try { doc = await firestore.readDocument(COLLECTION, id, "/"); }
  catch (_error) { return []; }
  return Object.entries(doc || {})
    .filter(([key, value]) => key !== "_id" && value && typeof value === "object")
    .map(([, value]) => callLogForClient(value))
    .sort((a, b) => (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0));
}

module.exports = { getCallLogs, saveCallLog };
