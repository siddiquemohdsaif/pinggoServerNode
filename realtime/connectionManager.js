const { randomUUID } = require("crypto");
const metrics = require("../services/performanceMetrics");

// accountId -> (deviceId -> WebSocket). Older clients receive a temporary
// connection id, so a second installation no longer evicts the first one.
const onlineUsers = new Map();

function addUser(userId, deviceId, ws) {
  userId = normalizeAccountId(userId);
  deviceId = normalizeString(deviceId) || `legacy-${randomUUID()}`;
  let devices = onlineUsers.get(userId);
  if (!devices) {
    devices = new Map();
    onlineUsers.set(userId, devices);
  }
  const existingSocket = devices.get(deviceId);
  if (existingSocket && existingSocket !== ws) {
    existingSocket.close(4000, "This device opened a newer connection.");
  }
  ws.userId = userId;
  ws.deviceId = deviceId;
  ws.isAuthenticated = true;
  ws.activeChatId = "";
  devices.set(deviceId, ws);
  metrics.increment("websocket.connections.opened");
  return deviceId;
}

function setActiveChat(userId, ws, chatId) {
  const devices = onlineUsers.get(normalizeAccountId(userId));
  if (!devices || devices.get(ws.deviceId) !== ws) return false;
  ws.activeChatId = normalizeString(chatId);
  return true;
}

function isUserViewingChat(userId, chatId) {
  const normalizedChatId = normalizeString(chatId);
  return Boolean(normalizedChatId && getUserSockets(userId)
    .some((socket) => socket.activeChatId === normalizedChatId));
}

function removeUser(userId, ws) {
  userId = normalizeAccountId(userId);
  if (!userId || !ws) return;
  const devices = onlineUsers.get(userId);
  if (!devices) return;
  if (devices.get(ws.deviceId) === ws) devices.delete(ws.deviceId);
  metrics.increment("websocket.connections.closed");
  if (devices.size === 0) onlineUsers.delete(userId);
}

// Kept for call code that currently selects one answering endpoint.
function getUserSocket(userId) {
  return getUserSockets(userId)[0] || null;
}

function getUserSockets(userId) {
  const normalizedUserId = normalizeAccountId(userId);
  const devices = onlineUsers.get(normalizedUserId)
    || onlineUsers.get(normalizePhoneNumberForChatId(normalizedUserId));
  return devices ? [...devices.values()] : [];
}

function sendToUser(userId, payload, sendJson, options = {}) {
  const exceptSocket = options.exceptSocket || null;
  let sent = 0;
  getUserSockets(userId).forEach((socket) => {
    if (socket !== exceptSocket) {
      sendJson(socket, payload);
      sent += 1;
    }
  });
  return sent;
}

function disconnectDevice(userId, deviceId, code = 4003, reason = "Device unlinked.") {
  const devices = onlineUsers.get(normalizeAccountId(userId));
  const socket = devices && devices.get(normalizeString(deviceId));
  if (!socket) return false;
  socket.close(code, reason);
  return true;
}

function notifyDeviceUnlinked(userId, deviceId, actorDeviceId, revokedAt = Date.now()) {
  const targetDeviceId = normalizeString(deviceId);
  const actor = normalizeString(actorDeviceId);
  const removedByPrimary = Boolean(actor && actor !== targetDeviceId);
  const payload = {
    type: "device_unlinked",
    deviceId: targetDeviceId,
    actorDeviceId: actor,
    reason: removedByPrimary ? "device_unlinked" : "self_logout",
    message: removedByPrimary
      ? "This companion device was logged out by the primary device." : "",
    revokedAt,
  };
  return sendToUser(userId, payload, (socket, event) => {
    if (socket.readyState === undefined || socket.readyState === 1) {
      try { socket.send(JSON.stringify(event)); } catch (_error) {}
    }
  });
}

function resolveUnlinkActorDeviceId(authenticatedDeviceId) {
  // An empty binding represents the account-bound primary credential.
  return normalizeString(authenticatedDeviceId) || "primary";
}

function disconnectAccount(userId, payload = { type: "account_logout" }) {
  const sockets = getUserSockets(userId);
  sockets.forEach((socket) => {
    if (socket.readyState === undefined || socket.readyState === 1) {
      try { socket.send(JSON.stringify(payload)); } catch (_error) {}
    }
    socket.close(4003, "Account logged out from primary device.");
  });
  return sockets.length;
}

function isUserOnline(userId) {
  return getUserSockets(userId).length > 0;
}

function getOnlineUserCount() {
  return onlineUsers.size;
}

function getOnlineDeviceCount() {
  let count = 0;
  onlineUsers.forEach((devices) => { count += devices.size; });
  return count;
}

module.exports = {
  addUser,
  removeUser,
  getUserSocket,
  getUserSockets,
  sendToUser,
  disconnectDevice,
  notifyDeviceUnlinked,
  resolveUnlinkActorDeviceId,
  disconnectAccount,
  isUserOnline,
  getOnlineUserCount,
  getOnlineDeviceCount,
  setActiveChat,
  isUserViewingChat,
};

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAccountId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.replace(/^<plus>/, "").replace(/^\+/, "");
}

function normalizePhoneNumberForChatId(value) {
  return (typeof value === "string" ? value.trim() : "")
    .replace("<plus>", "")
    .replace(/^\+/, "");
}
