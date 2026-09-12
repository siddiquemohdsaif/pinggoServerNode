const { randomUUID, createHash } = require("crypto");
const { getUserSocket, isUserViewingChat } = require("./connectionManager");
const { saveCallMessage } = require("./messageHandler");
const { saveCallLog } = require("../models/CallLogStore");
const { isBlockedBy } = require("../utils/blockUtils");
const { sendCallNotification, sendCallCancelledNotification } = require("./fcmService");
const { isAccountDeleted } = require("../services/accountDeletionService");
const groupService = require("../services/groupService");

const calls = new Map();
const callEndedListeners = new Set();
const CALL_TTL_MS = 2 * 60 * 60 * 1000;
const CALLING_TIMEOUT_MS = 45000;
const SIGNALING_RECONNECT_GRACE_MS = 15000;
const RELAY_TYPES = new Set([
  "call_ringing",
  "call_answer",
  "ice_candidate",
  "call_mute",
  "call_reject",
  "call_busy",
  "call_end",
  "call_leave",
]);

async function handleCallEvent(ws, payload, sendJson) {
  console.log(`[call] event type=${payload.type || ""} callId=${payload.callId || ""}`
    + ` sender=${ws.userId || ""} stateBefore=${calls.get(string(payload.callId))?.state || "none"}`
    + ` time=${Date.now()}`);
  cleanupExpiredCalls();
  if (payload.type === "call_invite") return handleInvite(ws, payload, sendJson);
  if (payload.type === "call_add_participants") {
    return handleAddLiveKitParticipants(ws, payload, sendJson);
  }
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

  if (call.engine === "livekit" && Array.isArray(call.participantIds)) {
    return handleLiveKitRelay(ws, payload, call, sendJson);
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

  if (payload.type === "call_answer" && call.state === "connected" && call.answer &&
      call.answer.description === payload.sdp.description) {
    sendJson(ws, { type: "call_answer_ack", callId, state: call.state,
      duplicate: true, serverTime: Date.now() });
    return true;
  }

  if (payload.type === "ice_candidate" && (call.state === "calling" || call.state === "ringing")) {
    call.pendingCandidates = call.pendingCandidates || [];
    call.pendingCandidates.push({ senderId: ws.userId, receiverId: expectedReceiver, candidate: payload.candidate });
    call.updatedAt = Date.now();
    sendJson(ws, { type: "ice_candidate_ack", callId, state: call.state, serverTime: Date.now() });
    return true;
  }

  if (payload.type === "call_answer") call.answer = payload.sdp;
  if (payload.type === "call_answer") console.log(`[call] answerSdp callId=${callId}`
    + ` length=${string(payload.sdp.description).length} hash=${sdpHash(payload.sdp.description)}`
    + ` hasBase64=${Boolean(payload.sdp.descriptionBase64)} time=${Date.now()}`);
  updateState(call, payload.type, string(payload.reason));
  if (payload.type === "call_answer") {
    console.log(`[call-connection] phase=signaling_connected callId=${callId}`
      + ` chatId=${call.chatId} caller=${call.callerId} receiver=${call.receiverId}`
      + ` mediaType=${call.mediaType} setupMs=${Math.max(0, call.connectedAt - call.createdAt)}`
      + ` serverTime=${call.connectedAt}`);
  }
  console.log(`[call] accepted type=${payload.type} callId=${callId} stateAfter=${call.state}`
    + ` receiver=${expectedReceiver} time=${Date.now()}`);
  const event = {
    ...payload,
    callId,
    callerId: call.callerId,
    senderId: ws.userId,
    receiverId: expectedReceiver,
    mediaType: call.mediaType,
    serverTime: Date.now(),
  };
  const receiverSocket = getUserSocket(expectedReceiver);
  if (receiverSocket) {
    sendJson(receiverSocket, event);
    if (payload.type !== "ice_candidate") {
      console.log(`[call-connection] phase=relay callId=${callId} type=${payload.type}`
        + ` from=${ws.userId} to=${expectedReceiver} delivered=true serverTime=${Date.now()}`);
    }
  } else if (payload.type !== "ice_candidate") {
    console.log(`[call-connection] phase=relay callId=${callId} type=${payload.type}`
      + ` from=${ws.userId} to=${expectedReceiver} delivered=false serverTime=${Date.now()}`);
  }
  if (payload.type === "call_answer") flushPendingCandidates(call, sendJson);
  sendJson(ws, { type: `${payload.type}_ack`, callId, state: call.state, serverTime: Date.now() });
  if (payload.type === "call_end" || payload.type === "call_reject" || payload.type === "call_busy") {
    notifyCallEnded(call);
    await finalizeCallMessage(call, sendJson);
    await updateEndedCallNotification(call,
      !call.connectedAt && ws.userId === call.callerId);
    setTimeout(() => calls.delete(callId), 30000);
  }
  return true;
}

async function handleAddLiveKitParticipants(ws, payload, sendJson) {
  const callId = string(payload.callId);
  const call = calls.get(callId);
  if (!call || call.engine !== "livekit" || !isParticipant(call, ws.userId)) {
    sendJson(ws, { type: "call_failed", callId,
      message: "LiveKit call not found or access denied." });
    return true;
  }
  const existing = new Set(Array.isArray(call.participantIds)
    ? call.participantIds.map(account)
    : [account(call.callerId), account(call.receiverId)]);
  const requested = Array.isArray(payload.participantIds)
    ? payload.participantIds.map(account).filter(Boolean) : [];
  const additions = [...new Set(requested)].filter((id) => !existing.has(id));
  if (!additions.length) {
    sendJson(ws, { type: "call_participants_added", callId, participantIds: [] });
    return true;
  }
  if (existing.size + additions.length > 20) {
    sendJson(ws, { type: "call_failed", callId, message: "A call supports up to 20 members." });
    return true;
  }
  const accepted = [];
  for (const userId of additions) {
    if (await isAccountDeleted(userId) || await isBlockedBy(ws.userId, userId)
        || await isBlockedBy(userId, ws.userId)) continue;
    existing.add(userId);
    accepted.push(userId);
  }
  call.participantIds = [...existing];
  call.invitedByParticipant = call.invitedByParticipant || {};
  for (const userId of accepted) call.invitedByParticipant[userId] = account(ws.userId);
  call.historyParticipantIds = [...new Set([
    ...(call.historyParticipantIds || []), ...accepted,
  ])];
  if (call.participantIds.length > 2) call.conference = true;
  call.updatedAt = Date.now();
  for (const userId of accepted) {
    const event = { type: "call_invite", engine: "livekit", callId, chatId: call.chatId,
      callerId: ws.userId, senderId: ws.userId, receiverId: userId,
      mediaType: call.mediaType, callMode: "group",
      participantIds: [...call.participantIds], serverTime: Date.now() };
    const socket = getUserSocket(userId);
    if (socket) sendJson(socket, event);
    if (!isUserViewingChat(userId, call.chatId)) {
      sendCallNotification({ receiverId: userId,
        call: { ...call, callerId: ws.userId } }).catch((error) =>
        console.error("Could not send added call-member notification:", error.message));
    }
  }
  const update = { type: "call_participants_added", engine: "livekit", callId,
    participantIds: [...call.participantIds], addedParticipantIds: accepted,
    addedBy: ws.userId, serverTime: Date.now() };
  for (const userId of call.participantIds) {
    const socket = getUserSocket(userId);
    if (socket) sendJson(socket, update);
  }
  console.log(`[call] livekitParticipantsAdded callId=${callId} addedBy=${ws.userId}`
    + ` accepted=${accepted.length} total=${call.participantIds.length}`);
  return true;
}

async function handleInvite(ws, payload, sendJson) {
  const receiverId = account(payload.receiverId);
  const requestedCallId = string(payload.callId);
  const chatId = string(payload.chatId);
  const mediaType = payload.mediaType === "video" ? "video" : "audio";
  const engine = payload.engine === "livekit" ? "livekit" : "legacy";
  if (engine === "livekit" && chatId.startsWith("grp_")) {
    return handleLiveKitGroupInvite(ws, payload, chatId, mediaType, sendJson);
  }
  console.log(`[call] invite callId=${requestedCallId || "generated"} caller=${ws.userId}`
    + ` receiver=${receiverId} mediaType=${mediaType} chatId=${chatId} time=${Date.now()}`);
  console.log(`[call] offerSdp callId=${requestedCallId || "generated"}`
    + ` length=${string(payload.sdp && payload.sdp.description).length}`
    + ` hash=${sdpHash(payload.sdp && payload.sdp.description)}`
    + ` hasBase64=${Boolean(payload.sdp && payload.sdp.descriptionBase64)} time=${Date.now()}`);
  if (!receiverId || receiverId === ws.userId) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Valid receiverId is required." });
    return true;
  }
  if (engine === "legacy" && !validDescription(payload.sdp, "offer")) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Valid SDP offer is required." });
    return true;
  }
  if (!validChatId(chatId, ws.userId, receiverId)) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId, message: "Valid chatId is required." });
    return true;
  }
  if (await isBlockedBy(ws.userId, receiverId)) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId,
      message: "Unblock this contact to make a call." });
    return true;
  }
  if (await isAccountDeleted(receiverId)) {
    sendJson(ws, { type: "call_failed", callId: requestedCallId,
      message: "This user no longer has a Pinggo account." });
    return true;
  }

  // WebSocket reconnects and client retries may repeat an invitation. Treat an
  // identical callId from the same participants as the same call, not a new
  // competing call, otherwise the caller receives a false call_busy event.
  const existingCall = requestedCallId ? calls.get(requestedCallId) : null;
  if (existingCall) {
    if (existingCall.callerId !== ws.userId || existingCall.receiverId !== receiverId ||
        existingCall.mediaType !== mediaType) {
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
    console.log(`[call-connection] phase=busy_rejected callId=${requestedCallId}`
      + ` caller=${ws.userId} receiver=${receiverId}`
      + ` callerBusy=${hasActiveCall(ws.userId)} receiverBusy=${hasActiveCall(receiverId)}`
      + ` serverTime=${Date.now()}`);
    sendJson(ws, { type: "call_busy", callId: requestedCallId, receiverId });
    return true;
  }

  const callId = requestedCallId || randomUUID();
  const suppressedForReceiver = await isBlockedBy(receiverId, ws.userId);
  const receiverSocket = suppressedForReceiver ? null : getUserSocket(receiverId);
  const call = { callId, chatId, callerId: ws.userId, receiverId, mediaType, engine,
    participantIds: engine === "livekit" ? [account(ws.userId), receiverId] : undefined,
    historyParticipantIds: engine === "livekit" ? [account(ws.userId), receiverId] : undefined,
    joinedParticipantIds: engine === "livekit" ? [account(ws.userId)] : undefined,
    invitedByParticipant: engine === "livekit" ? { [receiverId]: account(ws.userId) } : undefined,
    participantJoinedAt: engine === "livekit" ? {} : undefined,
    participantLeftAt: engine === "livekit" ? {} : undefined,
    conference: false,
    state: receiverSocket ? "ringing" : "calling", offer: payload.sdp,
    suppressedForReceiver,
    createdAt: Date.now(), ringingAt: receiverSocket ? Date.now() : null,
    connectedAt: null, endedAt: null, terminationReason: null,
    updatedAt: Date.now(), pendingCandidates: [] };
  calls.set(callId, call);
  console.log(`[call-connection] phase=invite_created callId=${callId} chatId=${chatId}`
    + ` caller=${call.callerId} receiver=${call.receiverId} mediaType=${mediaType}`
    + ` receiverOnline=${Boolean(receiverSocket)} serverTime=${call.createdAt}`);
  console.log(`[call] created callId=${callId} state=${call.state} receiverOnline=${Boolean(receiverSocket)}`
    + ` time=${Date.now()}`);
  if (receiverSocket) sendInvite(call, receiverSocket, sendJson);
  if (!isUserViewingChat(receiverId, chatId)) {
    sendCallNotification({ receiverId, call }).catch((error) =>
      console.error("Could not send incoming-call notification:", error.message));
  }
  sendJson(ws, { type: "call_invite_ack", callId, receiverId, state: call.state, serverTime: Date.now() });
  scheduleCallingTimeout(callId, sendJson);
  return true;
}

async function handleLiveKitGroupInvite(ws, payload, chatId, mediaType, sendJson) {
  const group = await groupService.readGroup(chatId);
  groupService.requireMember(group, ws.userId);
  const participantIds = Object.values(group.members || {})
    .filter((member) => member.status === "active")
    .map((member) => account(member.userId));
  const callId = string(payload.callId) || randomUUID();
  const existing = calls.get(callId);
  if (existing) {
    sendJson(ws, { type: "call_invite_ack", callId, engine: "livekit",
      state: existing.state, duplicate: true, serverTime: Date.now() });
    return true;
  }
  const call = { callId, chatId, callerId: ws.userId, receiverId: "",
    participantIds, historyParticipantIds: [...participantIds], mediaType,
    joinedParticipantIds: [account(ws.userId)], engine: "livekit", conference: true, state: "ringing",
    participantJoinedAt: {}, participantLeftAt: {},
    invitedByParticipant: Object.fromEntries(participantIds
      .filter((userId) => userId !== account(ws.userId))
      .map((userId) => [userId, account(ws.userId)])),
    createdAt: Date.now(), ringingAt: Date.now(), connectedAt: null,
    endedAt: null, updatedAt: Date.now() };
  calls.set(callId, call);
  for (const userId of participantIds) {
    if (userId === ws.userId) continue;
    const event = { type: "call_invite", engine: "livekit", callId, chatId,
      callerId: ws.userId, senderId: ws.userId, receiverId: userId,
      mediaType, callMode: "group", participantIds: [...participantIds],
      serverTime: Date.now() };
    const socket = getUserSocket(userId);
    if (socket) sendJson(socket, event);
    if (!isUserViewingChat(userId, chatId)) {
      sendCallNotification({ receiverId: userId, call }).catch((error) =>
        console.error("Could not send group call notification:", error.message));
    }
  }
  sendJson(ws, { type: "call_invite_ack", engine: "livekit", callId,
    state: call.state, serverTime: Date.now() });
  scheduleCallingTimeout(callId, sendJson);
  return true;
}

async function handleLiveKitRelay(ws, payload, call, sendJson) {
  const type = payload.type;
  if (type === "call_answer" && !call.connectedAt) {
    call.connectedAt = Date.now();
    call.state = "connected";
    call.updatedAt = call.connectedAt;
    call.participantJoinedAt = call.participantJoinedAt || {};
    call.participantJoinedAt[account(call.callerId)] = call.connectedAt;
    console.log(`[call-connection] phase=livekit_connected callId=${call.callId}`
      + ` chatId=${call.chatId} answeredBy=${ws.userId}`
      + ` participants=${call.participantIds.length} setupMs=${call.connectedAt - call.createdAt}`);
  }
  if (type === "call_answer") {
    call.participantJoinedAt = call.participantJoinedAt || {};
    if (!call.participantJoinedAt[account(ws.userId)]) {
      call.participantJoinedAt[account(ws.userId)] = Date.now();
    }
    call.joinedParticipantIds = [...new Set([
      ...(call.joinedParticipantIds || [call.callerId]), account(ws.userId),
    ])];
  }
  const endForEveryone = payload.reason === "end_for_everyone";
  const twoParty = !call.conference && call.participantIds.length <= 2;
  const conferenceLeave = call.conference && !endForEveryone
      && (type === "call_end" || type === "call_leave" || type === "call_reject");
  if ((!call.conference && type === "call_end")
      || (type === "call_reject" && twoParty) || endForEveryone) {
    call.state = type === "call_reject" ? "rejected" : "ended";
    call.endedAt = Date.now();
    call.updatedAt = call.endedAt;
    call.terminationReason = type === "call_reject" ? "rejected"
      : string(payload.reason) || "hangup";
  } else if (conferenceLeave || type === "call_leave" || type === "call_reject") {
    call.participantLeftAt = call.participantLeftAt || {};
    call.participantLeftAt[account(ws.userId)] = Date.now();
    call.participantIds = call.participantIds.filter((id) => id !== account(ws.userId));
    call.joinedParticipantIds = (call.joinedParticipantIds || [])
      .filter((id) => id !== account(ws.userId));
    call.updatedAt = Date.now();
    if (call.connectedAt && call.joinedParticipantIds.length <= 1) {
      call.state = "ended";
      call.endedAt = call.updatedAt;
      call.terminationReason = "last_participant_left";
    }
  }
  let relayType = conferenceLeave ? "call_leave" : type;
  if (call.state === "ended" && (conferenceLeave || type === "call_leave"
      || type === "call_reject")) relayType = "call_end";
  const event = { ...payload, type: relayType, engine: "livekit", callId: call.callId,
    callerId: call.callerId, senderId: ws.userId, mediaType: call.mediaType,
    serverTime: Date.now() };
  for (const userId of call.participantIds) {
    if (userId === ws.userId) continue;
    const socket = getUserSocket(userId);
    if (socket) sendJson(socket, event);
  }
  sendJson(ws, { type: `${type}_ack`, engine: "livekit", callId: call.callId,
    state: call.state, serverTime: Date.now() });
  if (call.state === "ended") {
    await finalizeCallMessage(call, sendJson);
    await updateEndedCallNotification(call, !call.connectedAt);
    notifyCallEnded(call);
    setTimeout(() => calls.delete(call.callId), 30000);
  } else if (call.state === "rejected") {
    await finalizeCallMessage(call, sendJson);
    await updateEndedCallNotification(call, false);
    notifyCallEnded(call);
    setTimeout(() => calls.delete(call.callId), 30000);
  }
  return true;
}

function deliverPendingCallsForUser(userId, sendJson) {
  const normalizedUserId = account(userId);
  cancelDisconnectGrace(normalizedUserId);
  console.log(`[call] userAuthenticated userId=${normalizedUserId} activeCalls=${calls.size} time=${Date.now()}`);
  const socket = getUserSocket(normalizedUserId);
  if (!socket) return;
  for (const call of calls.values()) {
    if (call.engine === "livekit" && Array.isArray(call.participantIds)
        && call.participantIds.includes(normalizedUserId)
        && call.callerId !== normalizedUserId && !isTerminal(call.state)) {
      const inviterId = account(call.invitedByParticipant?.[normalizedUserId]
        || call.callerId);
      sendJson(socket, { type: "call_invite", engine: "livekit", callId: call.callId,
        chatId: call.chatId, callerId: inviterId, senderId: inviterId,
        receiverId: normalizedUserId, mediaType: call.mediaType, callMode: "group",
        participantIds: [...call.participantIds],
        serverTime: Date.now() });
      continue;
    }
    if (call.receiverId !== normalizedUserId || call.state !== "calling"
        || call.suppressedForReceiver) continue;
    call.state = "ringing";
    if (!call.ringingAt) call.ringingAt = Date.now();
    call.updatedAt = Date.now();
    sendInvite(call, socket, sendJson);
    const callerSocket = getUserSocket(call.callerId);
    if (callerSocket) sendJson(callerSocket, {
      type: "call_ringing", callId: call.callId, callerId: call.callerId,
      senderId: call.receiverId, receiverId: call.callerId, mediaType: call.mediaType,
      serverTime: Date.now(),
    });
  }
}

async function handleCallDisconnect(userId, sendJson) {
  const disconnectedUserId = account(userId);
  if (!disconnectedUserId) return;
  console.log(`[call] signalingDisconnected userId=${disconnectedUserId} time=${Date.now()}`);
  for (const call of calls.values()) {
    if (!isParticipant(call, disconnectedUserId) || isTerminal(call.state)) continue;
    // LiveKit owns group media reconnection; losing PingGo signaling must not end
    // the room for every other participant.
    if (call.engine === "livekit" && Array.isArray(call.participantIds)) continue;
    call.disconnectTimers = call.disconnectTimers || new Map();
    if (call.disconnectTimers.has(disconnectedUserId)) continue;
    const timer = setTimeout(async () => {
      call.disconnectTimers.delete(disconnectedUserId);
      if (!calls.has(call.callId) || isTerminal(call.state) || getUserSocket(disconnectedUserId)) return;
      console.log(`[call] reconnectGraceExpired callId=${call.callId} userId=${disconnectedUserId}`
        + ` state=${call.state} time=${Date.now()}`);
      call.state = "ended";
      call.endedAt = Date.now(); call.terminationReason = "signaling_disconnected";
      call.updatedAt = Date.now();
      const peerId = disconnectedUserId === call.callerId ? call.receiverId : call.callerId;
      const peerSocket = getUserSocket(peerId);
      if (peerSocket) sendJson(peerSocket, {
        type: "call_end", callId: call.callId, callerId: call.callerId,
        senderId: disconnectedUserId, receiverId: peerId, mediaType: call.mediaType,
        reason: "signaling_disconnected", serverTime: Date.now(),
      });
      await finalizeCallMessage(call, sendJson);
      await updateEndedCallNotification(call,
        !call.connectedAt && disconnectedUserId === call.callerId);
      notifyCallEnded(call);
      setTimeout(() => calls.delete(call.callId), 30000);
    }, SIGNALING_RECONNECT_GRACE_MS);
    if (typeof timer.unref === "function") timer.unref();
    call.disconnectTimers.set(disconnectedUserId, timer);
    console.log(`[call] reconnectGraceStarted callId=${call.callId} userId=${disconnectedUserId}`
      + ` graceMs=${SIGNALING_RECONNECT_GRACE_MS} time=${Date.now()}`);
  }
}

function cancelDisconnectGrace(userId) {
  for (const call of calls.values()) {
    if (!call.disconnectTimers) continue;
    const timer = call.disconnectTimers.get(userId);
    if (timer) clearTimeout(timer);
    if (timer) console.log(`[call] reconnectGraceCancelled callId=${call.callId} userId=${userId}`
      + ` time=${Date.now()}`);
    call.disconnectTimers.delete(userId);
  }
}

function sendInvite(call, socket, sendJson) {
  sendJson(socket, {
    type: "call_invite", callId: call.callId, callerId: call.callerId,
    chatId: call.chatId,
    senderId: call.callerId, receiverId: call.receiverId, mediaType: call.mediaType,
    engine: call.engine || "legacy", sdp: call.offer, serverTime: Date.now(),
  });
}

function scheduleCallingTimeout(callId, sendJson) {
  const timer = setTimeout(async () => {
    const call = calls.get(callId);
    if (!call || call.state === "connected" || isTerminal(call.state)) return;
    console.log(`[call] noAnswerTimeout callId=${callId} state=${call.state} time=${Date.now()}`);
    call.state = "ended";
    call.endedAt = Date.now(); call.terminationReason = "no_answer";
    call.updatedAt = Date.now();
    const callerSocket = getUserSocket(call.callerId);
    if (callerSocket) sendJson(callerSocket, {
      type: "call_no_answer", callId, callerId: call.callerId,
      receiverId: call.callerId, mediaType: call.mediaType, serverTime: Date.now(),
    });
    const receiverSocket = getUserSocket(call.receiverId);
    if (receiverSocket) sendJson(receiverSocket, {
      type: "call_end", callId, callerId: call.callerId,
      senderId: call.callerId, receiverId: call.receiverId, mediaType: call.mediaType,
      reason: "no_answer", serverTime: Date.now(),
    });
    await finalizeCallMessage(call, sendJson);
    await updateEndedCallNotification(call, true);
    notifyCallEnded(call);
    setTimeout(() => calls.delete(callId), 30000);
  }, CALLING_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function validateRelay(payload) {
  const call = calls.get(string(payload.callId));
  if (payload.type === "call_answer" && call?.engine !== "livekit"
      && !validDescription(payload.sdp, "answer")) return "Valid SDP answer is required.";
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
      senderId: pending.senderId, receiverId: pending.receiverId, mediaType: call.mediaType,
      candidate: pending.candidate, serverTime: Date.now(),
    });
  }
  call.pendingCandidates = [];
}

function validDescription(value, expectedType) {
  return value && typeof value === "object" && string(value.type) === expectedType && string(value.description).length > 10;
}
function updateState(call, type, reason) {
  if (type === "call_answer") {
    call.state = "connected";
    if (!call.connectedAt) call.connectedAt = Date.now();
  }
  else if (type === "call_end") { call.state = "ended"; call.endedAt = Date.now();
    call.terminationReason = reason || "hangup"; }
  else if (type === "call_reject") { call.state = "rejected"; call.endedAt = Date.now();
    call.terminationReason = "rejected"; }
  else if (type === "call_busy") { call.state = "busy"; call.endedAt = Date.now();
    call.terminationReason = "busy"; }
  else if (type === "call_ringing") { call.state = "ringing";
    if (!call.ringingAt) call.ringingAt = Date.now(); }
  call.updatedAt = Date.now();
}
async function finalizeCallMessage(call, sendJson) {
  if (!call || call.messageSaved) return;
  call.messageSaved = true;
  const finalizedAt = Date.now();
  call.endedAt = call.endedAt || finalizedAt;
  const durationSeconds = call.connectedAt
    ? Math.max(0, Math.floor((call.endedAt - call.connectedAt) / 1000)) : 0;
  console.log(`[call] finalize callId=${call.callId} state=${call.state}`
    + ` connectedAt=${call.connectedAt || 0} endedAt=${call.endedAt}`
    + ` durationSeconds=${durationSeconds} terminationReason=${call.terminationReason || "unknown"}`
    + ` time=${finalizedAt}`);
  const conference = Boolean(call.conference || call.chatId.startsWith("grp_")
    || (Array.isArray(call.participantIds) && call.participantIds.length > 2));
  const groupCall = call.chatId.startsWith("grp_");
  const label = groupCall
    ? (call.mediaType === "video" ? "Group Video Call" : "Group Voice Call")
    : conference
    ? (call.mediaType === "video" ? "Conference Video Call" : "Conference Voice Call")
    : (call.mediaType === "video" ? "Video Call" : "Voice Call");
  const text = call.connectedAt
    ? `[${label}] ${formatDuration(durationSeconds)}` : `[${label}] missed`;
  const callerText = call.connectedAt ? text : `[${label}] didn't connect`;
  const receiverText = call.connectedAt ? text : `[${label}] missed`;
  try {
    const savedMessage = await saveCallMessage({ callId: call.callId, chatId: call.chatId,
      callerId: call.callerId, receiverId: call.receiverId, mediaType: call.mediaType,
      conference, groupCall, participantIds: call.historyParticipantIds || call.participantIds,
      participantInviterIds: call.invitedByParticipant || {},
      participantJoinedAt: call.participantJoinedAt,
      participantLeftAt: call.participantLeftAt,
      text, callerText, receiverText, durationSeconds,
      createdAt: call.createdAt, ringingAt: call.ringingAt,
      connectedAt: call.connectedAt, endedAt: call.endedAt,
      terminationReason: call.terminationReason || "unknown",
      suppressedForReceiver: Boolean(call.suppressedForReceiver) }, sendJson);
    const savedLog = await saveCallLog({ ...call, messageId: savedMessage.id });
    for (const userId of (call.historyParticipantIds || [call.callerId, call.receiverId])) {
      const socket = getUserSocket(userId);
      if (socket) sendJson(socket, { type: "calls_list_updated", call: {
        ...savedLog,
        durationSeconds: savedLog.participantDurationsSeconds?.[account(userId)]
          ?? savedLog.durationSeconds,
      } });
    }
  } catch (error) {
    call.messageSaved = false;
    console.error("Could not save call message/log:", error.message);
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
function isParticipant(call, userId) {
  return Array.isArray(call.participantIds)
    ? call.participantIds.includes(account(userId))
    : call.callerId === userId || call.receiverId === userId;
}
function isTerminal(state) { return state === "ended" || state === "rejected" || state === "busy"; }
function cleanupExpiredCalls() {
  const cutoff = Date.now() - CALL_TTL_MS;
  for (const [id, call] of calls) if (call.updatedAt < cutoff) calls.delete(id);
}
function canJoinMedia(callId, userId) {
  cleanupExpiredCalls();
  const call = calls.get(string(callId));
  return Boolean(call && call.mediaType === "video" && call.state === "connected" &&
    isParticipant(call, account(userId)));
}
function canJoinLiveKitCall(callId, userId) {
  const call = calls.get(string(callId));
  return Boolean(call && call.engine === "livekit" && isParticipant(call, account(userId)));
}
function getCallMediaInfo(callId) {
  const call = calls.get(string(callId));
  if (!call) return null;
  return { callId: call.callId, callerId: call.callerId, receiverId: call.receiverId,
    mediaType: call.mediaType, state: call.state };
}
function addCallEndedListener(listener) {
  callEndedListeners.add(listener);
  return () => callEndedListeners.delete(listener);
}
function notifyCallEnded(call) {
  if (!call || call.mediaEndedNotified) return;
  call.mediaEndedNotified = true;
  for (const listener of callEndedListeners) {
    try { listener(call.callId); } catch (_error) {}
  }
}

async function updateEndedCallNotification(call, showMissed) {
  if (!call) return;
  try {
    if (showMissed && !call.connectedAt && !call.suppressedForReceiver
        && !isUserViewingChat(call.receiverId, call.chatId)) {
      // Reusing callId replaces the ringing card with the missed-call card.
      await sendCallNotification({ receiverId: call.receiverId, call, missed: true });
    } else {
      // Declines and completed calls must only remove a stale ringing card.
      await sendCallCancelledNotification({ receiverId: call.receiverId,
        callId: call.callId });
    }
  } catch (error) {
    console.error("Could not update ended call notification:", error.message);
  }
}
function account(value) { return string(value).replace(/^<plus>/, "").replace(/^\+/, ""); }
function string(value) { return typeof value === "string" ? value.trim() : ""; }
function sdpHash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : "")
    .digest("hex").slice(0, 12);
}

module.exports = { handleCallEvent, deliverPendingCallsForUser, handleCallDisconnect,
  canJoinMedia, canJoinLiveKitCall, getCallMediaInfo, addCallEndedListener };
