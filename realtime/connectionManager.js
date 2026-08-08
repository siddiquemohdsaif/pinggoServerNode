const onlineUsers = new Map();

function addUser(userId, ws) {
  userId = normalizeAccountId(userId);
  const existingSocket = onlineUsers.get(userId);
  if (existingSocket && existingSocket !== ws) {
    existingSocket.close(4000, "User connected from another socket.");
  }

  ws.userId = userId;
  ws.isAuthenticated = true;
  onlineUsers.set(userId, ws);
}

function removeUser(userId, ws) {
  userId = normalizeAccountId(userId);
  if (!userId) {
    return;
  }

  const existingSocket = onlineUsers.get(userId);
  if (existingSocket === ws) {
    onlineUsers.delete(userId);
  }
}

function getUserSocket(userId) {
  const normalizedUserId = normalizeAccountId(userId);
  return onlineUsers.get(normalizedUserId) ||
    onlineUsers.get(normalizePhoneNumberForChatId(normalizedUserId)) ||
    null;
}

function isUserOnline(userId) {
  return Boolean(getUserSocket(userId));
}

function getOnlineUserCount() {
  return onlineUsers.size;
}

module.exports = {
  addUser,
  removeUser,
  getUserSocket,
  isUserOnline,
  getOnlineUserCount,
};

function normalizeAccountId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("<plus>")) {
    return normalized;
  }
  if (normalized.startsWith("+")) {
    return `<plus>${normalized.slice(1)}`;
  }
  if (/^[0-9]{7,15}$/.test(normalized)) {
    return `<plus>${normalized}`;
  }
  return normalized;
}

function normalizePhoneNumberForChatId(value) {
  return (typeof value === "string" ? value.trim() : "")
    .replace("<plus>", "")
    .replace(/^\+/, "");
}
