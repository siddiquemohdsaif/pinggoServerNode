const crypto = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");
const AES = require("../utils/AES_256");
const { canJoinMedia, getCallMediaInfo, addCallEndedListener } = require("./callHandler");

const mediaRooms = new Map();
const VIDEO_PACKET_TYPE = 1;
const FORMAT_JPEG = 1;
const VIDEO_PACKET_HEADER_BYTES = 33;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = MAX_JPEG_BYTES + VIDEO_PACKET_HEADER_BYTES;
const MAX_RECEIVER_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1440;
const MAX_FPS = 30;

function createMediaWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        relayBinaryFrame(ws, Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      handleJson(ws, data);
    });
    ws.on("close", () => leaveRoom(ws, false));
    ws.on("error", () => {});
  });
  addCallEndedListener((callId) => closeRoom(callId));
  return wss;
}

function handleJson(ws, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); }
  catch (_error) { return sendError(ws, "INVALID_JSON", "Message must be valid JSON."); }
  if (message.type === "client.join") return joinRoom(ws, message);
  if (message.type === "client.leave") return leaveRoom(ws, true);
  if (message.type === "client.media_state") return relayMediaState(ws, message);
  sendError(ws, "UNSUPPORTED_MESSAGE", `Unsupported message type: ${message.type || "unknown"}`);
}

function joinRoom(ws, message) {
  const callId = string(message.callId);
  const userId = account(message.userId);
  const credential = credentialFrom(message.authToken, userId);
  if (!callId || !userId || !credential || !AES.validateEncryptedCredentialByUID(credential, userId)) {
    sendError(ws, "AUTH_FAILED", "Valid media authentication is required.");
    return ws.close(4001, "Media authentication failed.");
  }
  if (!canJoinMedia(callId, userId)) {
    sendError(ws, "CALL_ACCESS_DENIED", "User cannot join this media call.");
    return ws.close(4003, "Media call access denied.");
  }
  const call = getCallMediaInfo(callId);
  if (!call || (call.callerId !== userId && call.receiverId !== userId)) {
    sendError(ws, "CALL_ACCESS_DENIED", "User is not a call participant.");
    return ws.close(4003, "Media call access denied.");
  }
  leaveRoom(ws, false);
  const room = getRoom(callId);
  for (const participant of room) {
    if (participant.mediaUserId === userId) participant.close(4000, "Media reconnected.");
  }
  if (room.size >= 2) {
    sendError(ws, "ROOM_FULL", "Media room already has two participants.");
    return ws.close(4004, "Media room full.");
  }
  const existingParticipants = Array.from(room).map(publicParticipant);
  ws.mediaCallId = callId;
  ws.mediaUserId = userId;
  ws.mediaCUuid = generateCUuid(callId, userId, room);
  ws.mediaDisplayName = string(message.displayName);
  ws.mediaCameraEnabled = true;
  ws.mediaMicrophoneMuted = false;
  room.add(ws);
  sendJson(ws, { type: "server.joined", callId, userId, cUuid: ws.mediaCUuid,
    mediaCapabilities: { imageFormats: ["jpeg"], defaultImageFormat: "jpeg" },
    participants: existingParticipants });
  for (const peer of room) if (peer !== ws) sendJson(peer, {
    type: "server.participant_joined", callId, participant: publicParticipant(ws) });
}

function relayBinaryFrame(ws, packet) {
  if (!ws.mediaCallId || !mediaRooms.has(ws.mediaCallId)) {
    return sendError(ws, "NOT_IN_CALL", "Join a media call before sending video.");
  }
  if (!allowFrame(ws)) {
    console.warn(`[media] frameRateLimited callId=${ws.mediaCallId} userId=${ws.mediaUserId}` +
      ` frames=${ws.mediaFramesInWindow} bytes=${packet ? packet.length : 0} time=${Date.now()}`);
    return sendError(ws, "VIDEO_RATE_LIMIT", "Video frame rate limit exceeded.");
  }
  const validationError = packetValidationError(ws, packet);
  if (validationError) {
    console.warn(`[media] invalidBinaryVideo callId=${ws.mediaCallId} userId=${ws.mediaUserId}` +
      ` cUuid=${ws.mediaCUuid} bytes=${packet ? packet.length : 0} time=${Date.now()}`);
    return sendError(ws, validationError.code, validationError.message);
  }
  for (const peer of mediaRooms.get(ws.mediaCallId)) {
    if (peer !== ws && peer.readyState === WebSocket.OPEN &&
        peer.bufferedAmount < MAX_RECEIVER_BUFFERED_BYTES) peer.send(packet, { binary: true });
  }
}

function packetValidationError(ws, packet) {
  if (!packet || packet.length < VIDEO_PACKET_HEADER_BYTES)
    return { code: "VIDEO_INVALID_HEADER", message: "Video packet header is incomplete." };
  let offset = 0;
  while (offset < packet.length) {
    if (packet.length - offset < VIDEO_PACKET_HEADER_BYTES)
      return { code: "VIDEO_INVALID_HEADER", message: "Video packet header is incomplete." };
    const type = packet.readUInt16BE(offset);
    const cUuid = packet.readUInt32BE(offset + 2);
    const format = packet.readUInt8(offset + 14);
    const width = packet.readUInt16BE(offset + 15);
    const height = packet.readUInt16BE(offset + 17);
    const fps = packet.readUInt16BE(offset + 19);
    const payloadLength = packet.readUInt32BE(offset + 29);
    const next = offset + VIDEO_PACKET_HEADER_BYTES + payloadLength;
    if (type !== VIDEO_PACKET_TYPE || cUuid !== ws.mediaCUuid)
      return { code: "VIDEO_INVALID_HEADER", message: "Video packet identity is invalid." };
    if (format !== FORMAT_JPEG)
      return { code: "VIDEO_UNSUPPORTED_FORMAT", message: "Video image format is unsupported." };
    if (width < 1 || width > MAX_WIDTH || height < 1 || height > MAX_HEIGHT || fps > MAX_FPS)
      return { code: "VIDEO_INVALID_DIMENSIONS", message: "Video dimensions or FPS are invalid." };
    if (payloadLength < 1 || payloadLength > MAX_JPEG_BYTES || next > packet.length)
      return { code: "VIDEO_PAYLOAD_LENGTH_MISMATCH", message: "Video payload length is invalid." };
    offset = next;
  }
  return offset === packet.length ? null :
    { code: "VIDEO_PAYLOAD_LENGTH_MISMATCH", message: "Video packet has trailing bytes." };
}

function allowFrame(ws) {
  const now = Date.now();
  if (!ws.mediaRateWindowAt || now - ws.mediaRateWindowAt >= 1000) {
    ws.mediaRateWindowAt = now; ws.mediaFramesInWindow = 0;
  }
  ws.mediaFramesInWindow += 1;
  return ws.mediaFramesInWindow <= 35;
}

function relayMediaState(ws, message) {
  const room = mediaRooms.get(ws.mediaCallId);
  if (!room) return sendError(ws, "NOT_IN_CALL", "Join a media call first.");
  ws.mediaMicrophoneMuted = Boolean(message.microphoneMuted);
  ws.mediaCameraEnabled = message.cameraEnabled !== false;
  for (const peer of room) if (peer !== ws) sendJson(peer, { type: "server.media_state",
    callId: ws.mediaCallId, userId: ws.mediaUserId,
    microphoneMuted: ws.mediaMicrophoneMuted, cameraEnabled: ws.mediaCameraEnabled });
}

function leaveRoom(ws, notify) {
  const callId = ws.mediaCallId;
  const room = callId && mediaRooms.get(callId);
  if (!room) return;
  const participant = publicParticipant(ws);
  room.delete(ws);
  if (notify) sendJson(ws, { type: "server.left", callId, userId: ws.mediaUserId });
  for (const peer of room) sendJson(peer, { type: "server.participant_left", callId, participant });
  if (room.size === 0) mediaRooms.delete(callId);
  ws.mediaCallId = null; ws.mediaCUuid = null;
}

function closeRoom(callId) {
  const room = mediaRooms.get(callId);
  if (!room) return;
  mediaRooms.delete(callId);
  for (const ws of room) {
    sendJson(ws, { type: "server.left", callId, userId: ws.mediaUserId, reason: "call_ended" });
    ws.mediaCallId = null; ws.mediaCUuid = null;
    ws.close(1000, "Call ended.");
  }
}

function getRoom(callId) {
  if (!mediaRooms.has(callId)) mediaRooms.set(callId, new Set());
  return mediaRooms.get(callId);
}
function publicParticipant(ws) { return { userId: ws.mediaUserId, cUuid: ws.mediaCUuid,
  displayName: ws.mediaDisplayName || null, microphoneMuted: Boolean(ws.mediaMicrophoneMuted),
  cameraEnabled: ws.mediaCameraEnabled !== false, imageFormats: ["jpeg"], preferredImageFormat: "jpeg" }; }
function generateCUuid(callId, userId, room) {
  const hash = crypto.createHash("sha256").update(`${callId}:${userId}`).digest();
  let value = hash.readUInt32BE(0) & 0x7fffffff;
  if (!value) value = 1;
  const used = new Set(Array.from(room).map((peer) => peer.mediaCUuid));
  while (used.has(value)) value = value >= 0x7fffffff ? 1 : value + 1;
  return value;
}
function credentialFrom(value, userId) {
  const token = string(value).replace(/^Bearer\s+/i, "");
  const prefix = `${account(userId)}_`;
  return token.startsWith(prefix) ? token.slice(prefix.length) : token;
}
function account(value) { return string(value).replace(/^<plus>/, "").replace(/^\+/, ""); }
function string(value) { return typeof value === "string" ? value.trim() : ""; }
function sendError(ws, code, message) { sendJson(ws, { type: "server.error", code, message }); }
function sendJson(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }

module.exports = { createMediaWebSocketServer };
