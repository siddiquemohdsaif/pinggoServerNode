const { randomUUID } = require("crypto");
const { getUserSocket } = require("./connectionManager");
const { saveCallMessage } = require("./messageHandler");

const calls = new Map();
const CALL_TTL_MS = 2 * 60 * 60 * 1000;
const CALLING_TIMEOUT_MS = 45000;
const RELAY_TYPES = new Set([
  "call_ringing",
  "call_answer",
  "ice_candidate",
  "call_mute",
  "call_reject",
  "call_busy",
  "call_end",
]);

async function handleCallEvent(ws, payload, sendJson) {
  cleanupExpiredCalls();
  if (payload.type === "call_invite") return handleInvite(ws, payload, sendJson);
  if (!RELAY_TYPES.has(payload.type)) return false;

  const callId = string(payload.callId);
  const call = calls.get(callId);
  if (!call || !isParticipant(call, ws.userId)) {
    sendJson(ws, { type: "call_failed", callId, message: "Call not found or access denied." });
    return true;
  }
  if (isTerminal(call.state)) {
    sendJson(ws, { type: "call_failed", callId, message: "Call has already ended." });
    return true;
  }

  const expectedReceiver = ws.userId === call.callerId ? call.receiverId : call.callerId;
  const requestedReceiver = account(payload.receiverId);
  if (requestedReceiver && requestedReceiver !== expectedReceiver) {
    sendJson(ws, { type: "call_failed", callId, message: "Invalid call receiver." });
    return true;
  }
  const validation = validateRelay(payload);
  if (validation) {
    sendJson(ws, { type: "call_failed", callId, message: validation });
    return true;
  }

  if (payload.type === "ice_candidate" && (call.state === "calling" || call.state === "ringing")) {
    call.pendingCandidates = call.pendingCandidates || [];
    call.pendingCandidates.push({ senderId: ws.userId, receiverId: expectedReceiver, candidate: payload.candidate });
    call.updatedAt = Date.now();
    sendJson(ws, { type: "ice_candidate_ack", callId, state: call.state, serverTime: Date.now() });
    return true;
  }

  updateState(call, payload.type);
  const event = {
    ...payload,
    callId,
    callerId: call.callerId,
    senderId: ws.userId,
    receiverId: expectedReceiver,
    mediaType: "audio",
    serverTime: Date.now(),
  };
  const receiverSocket = getUserSocket(expectedReceiver);
  if (receiverSocket) sendJson(receiverSocket, event);
  if (payload.type === "call_answer") flushPendingCandidates(call, sendJson);
  sendJson(ws, { type: `${payload.type}_ack`, callId, state: call.state, serverTime: Date.now() });
  if (payload.type === "call_end" || payload.type === "call_reject" || payload.type === "call_busy") {
    await finalizeCallMessage(call, sendJson);
    setTimeout(() => calls.delete(callId), 30000);
  }
  return true;
}

function handleInvite(ws, payload, sendJson) {
  const receiverId = account(payload.receiverId);
  const requestedCallId = string(payload.callId);
  const chatId = string(payload.chatId);
  if (!receiverId || receiverId === ws.userId) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Valid receiverId is required." });
    return true;
  }
  if (!validDescription(payload.sdp, "offer")) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Valid SDP offer is required." });
    return true;
  }
  if (!validChatId(chatId, ws.userId, receiverId)) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Valid chatId is required." });
    return true;
  }

  // WebSocket reconnects and client retries may repeat an invitation. Treat an
  // identical callId from the same participants as the same call, not a new
  // competing call, otherwise the caller receives a false call_busy event.
  const existingCall = requestedCallId ? calls.get(requestedCallId) : null;
  if (existingCall) {
    if (existingCall.callerId !== ws.userId || existingCall.receiverId !== receiverId) {
      sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Call id is already in use." });
      return true;
    }
    if (isTerminal(existingCall.state)) {
      sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Call has already ended." });
      return true;
    }
    existingCall.updatedAt = Date.now();
    existingCall.offer = payload.sdp;
    const existingReceiverSocket = getUserSocket(receiverId);
    if (existingReceiverSocket && existingCall.state !== "connected") {
      existingCall.state = "ringing";
      sendInvite(existingCall, existingReceiverSocket, sendJson);
    }
    sendJson(ws, {
      type: "call_invite_ack", callId: existingCall.callId, receiverId,
      state: existingCall.state, duplicate: true, serverTime: Date.now(),
    });
    return true;
  }

  if (hasActiveCall(ws.userId) || hasActiveCall(receiverId)) {
    sendJson(ws, { type: "call_busy", callId: requestedCallId, receiverId });
    return true;
  }

  const callId = requestedCallId || randomUUID();
  const receiverSocket = getUserSocket(receiverId);
  const call = { callId, chatId, callerId: ws.userId, receiverId,
    state: receiverSocket ? "ringing" : "calling", offer: payload.sdp,
    createdAt: Date.now(), updatedAt: Date.now(), pendingCandidates: [] };
  calls.set(callId, call);
  if (receiverSocket) sendInvite(call, receiverSocket, sendJson);
  sendJson(ws, { type: "call_invite_ack", callId, receiverId, state: call.state, serverTime: Date.now() });
  scheduleCallingTimeout(callId, sendJson);
  return true;
}

function deliverPendingCallsForUser(userId, sendJson) {
  const normalizedUserId = account(userId);
  const socket = getUserSocket(normalizedUserId);
  if (!socket) return;
  for (const call of calls.values()) {
    if (call.receiverId !== normalizedUserId || call.state !== "calling") continue;
    call.state = "ringing";
    call.updatedAt = Date.now();
    sendInvite(call, socket, sendJson);
    const callerSocket = getUserSocket(call.callerId);
    if (callerSocket) sendJson(callerSocket, {
      type: "call_ringing", callId: call.callId, callerId: call.callerId,
      senderId: call.receiverId, receiverId: call.callerId, mediaType: "audio",
      serverTime: Date.now(),
    });
  }
}

async function handleCallDisconnect(userId, sendJson) {
  const disconnectedUserId = account(userId);
  if (!disconnectedUserId) return;
  for (const call of calls.values()) {
    if (!isParticipant(call, disconnectedUserId) || isTerminal(call.state)) continue;
    call.state = "ended";
    call.updatedAt = Date.now();
    const peerId = disconnectedUserId === call.callerId ? call.receiverId : call.callerId;
    const peerSocket = getUserSocket(peerId);
    if (peerSocket) sendJson(peerSocket, {
      type: "call_end",
      callId: call.callId,
      callerId: call.callerId,
      senderId: disconnectedUserId,
      receiverId: peerId,
      mediaType: "audio",
      reason: "signaling_disconnected",
      serverTime: Date.now(),
    });
    await finalizeCallMessage(call, sendJson);
    setTimeout(() => calls.delete(call.callId), 30000);
  }
}

function sendInvite(call, socket, sendJson) {
  sendJson(socket, {
    type: "call_invite", callId: call.callId, callerId: call.callerId,
    chatId: call.chatId,
    senderId: call.callerId, receiverId: call.receiverId, mediaType: "audio",
    sdp: call.offer, serverTime: Date.now(),
  });
}

function scheduleCallingTimeout(callId, sendJson) {
  const timer = setTimeout(async () => {
    const call = calls.get(callId);
    if (!call || call.state === "connected" || isTerminal(call.state)) return;
    call.state = "ended";
    call.updatedAt = Date.now();
    const callerSocket = getUserSocket(call.callerId);
    if (callerSocket) sendJson(callerSocket, {
      type: "call_no_answer", callId, callerId: call.callerId,
      receiverId: call.callerId, mediaType: "audio", serverTime: Date.now(),
    });
    const receiverSocket = getUserSocket(call.receiverId);
    if (receiverSocket) sendJson(receiverSocket, {
      type: "call_end", callId, callerId: call.callerId,
      senderId: call.callerId, receiverId: call.receiverId, mediaType: "audio",
      reason: "no_answer", serverTime: Date.now(),
    });
    await finalizeCallMessage(call, sendJson);
    setTimeout(() => calls.delete(callId), 30000);
  }, CALLING_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function validateRelay(payload) {
  if (payload.type === "call_answer" && !validDescription(payload.sdp, "answer")) return "Valid SDP answer is required.";
  if (payload.type === "ice_candidate") {
    const candidate = payload.candidate;
    if (!candidate || typeof candidate !== "object" || !string(candidate.candidate)) return "Valid ICE candidate is required.";
  }
  return "";
}
function flushPendingCandidates(call, sendJson) {
  for (const pending of call.pendingCandidates || []) {
    const target = getUserSocket(pending.receiverId);
    if (target) sendJson(target, {
      type: "ice_candidate", callId: call.callId, callerId: call.callerId,
      senderId: pending.senderId, receiverId: pending.receiverId, mediaType: "audio",
      candidate: pending.candidate, serverTime: Date.now(),
    });
  }
  call.pendingCandidates = [];
}

function validDescription(value, expectedType) {
  return value && typeof value === "object" && string(value.type) === expectedType && string(value.description).length > 10;
}
function updateState(call, type) {
  if (type === "call_answer") {
    call.state = "connected";
    if (!call.connectedAt) call.connectedAt = Date.now();
  }
  else if (type === "call_end") call.state = "ended";
  else if (type === "call_reject") call.state = "rejected";
  else if (type === "call_busy") call.state = "busy";
  else if (type === "call_ringing") call.state = "ringing";
  call.updatedAt = Date.now();
}
async function finalizeCallMessage(call, sendJson) {
  if (!call || call.messageSaved) return;
  call.messageSaved = true;
  const durationSeconds = call.connectedAt
    ? Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000)) : 0;
  const text = call.connectedAt
    ? `[Voice Call] ${formatDuration(durationSeconds)}` : "[Voice Call] missed";
  try {
    await saveCallMessage({ callId: call.callId, chatId: call.chatId,
      callerId: call.callerId, receiverId: call.receiverId, text, durationSeconds }, sendJson);
  } catch (error) {
    call.messageSaved = false;
    console.error("Could not save voice call message:", error.message);
  }
}
function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pair = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${pair(hours)}:${pair(minutes)}:${pair(seconds)}`
    : `${pair(minutes)}:${pair(seconds)}`;
}
function validChatId(chatId, firstUserId, secondUserId) {
  if (!chatId) return false;
  const participants = chatId.split("_").map(account);
  return participants.includes(account(firstUserId)) && participants.includes(account(secondUserId));
}
function hasActiveCall(userId) {
  for (const call of calls.values()) if (isParticipant(call, userId) && !isTerminal(call.state)) return true;
  return false;
}
function isParticipant(call, userId) { return call.callerId === userId || call.receiverId === userId; }
function isTerminal(state) { return state === "ended" || state === "rejected" || state === "busy"; }
function cleanupExpiredCalls() {
  const cutoff = Date.now() - CALL_TTL_MS;
  for (const [id, call] of calls) if (call.updatedAt < cutoff) calls.delete(id);
}
function account(value) { return string(value).replace(/^<plus>/, "").replace(/^\+/, ""); }
function string(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { handleCallEvent, deliverPendingCallsForUser, handleCallDisconnect };
