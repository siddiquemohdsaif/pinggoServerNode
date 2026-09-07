const onlineUsers = new Map();

function addUser(userId, ws) {
  userId = normalizeAccountId(userId);
  const existingSocket = onlineUsers.get(userId);
  if (existingSocket && existingSocket !== ws) {
    existingSocket.close(4000, "User connected from another socket.");
  }

  ws.userId = userId;
  ws.isAuthenticated = true;
  ws.activeChatId = "";
  onlineUsers.set(userId, ws);
}

function setActiveChat(userId, ws, chatId) {
  const currentSocket = getUserSocket(userId);
  if (!currentSocket || currentSocket !== ws) return false;
  currentSocket.activeChatId = normalizeString(chatId);
  return true;
}

function isUserViewingChat(userId, chatId) {
  const socket = getUserSocket(userId);
  const normalizedChatId = normalizeString(chatId);
  return Boolean(socket && normalizedChatId && socket.activeChatId === normalizedChatId);
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
