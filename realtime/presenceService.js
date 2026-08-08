const FirestoreManager = require("../Firestore/FirestoreManager");
const { getUserSocket, isUserOnline } = require("./connectionManager");

const firestoreManager = FirestoreManager.getInstance();

async function markUserOnline(userId) {
  await updateUserPresence(userId, {
    isOnline: true,
    lastSeen: Date.now(),
  });
}

async function markUserOffline(userId) {
  const lastSeen = Date.now();
  await updateUserPresence(userId, {
    isOnline: false,
    lastSeen,
  });
  return lastSeen;
}

async function updateUserPresence(userId, presenceFields) {
  if (!userId) {
    return null;
  }

  try {
    const userDoc = await firestoreManager.readDocument("Users", userId, "/");
    if (!userDoc) {
      return null;
    }

    const updatedUser = {
      ...userDoc,
      ...presenceFields,
    };
    delete updatedUser._id;

    await firestoreManager.updateDocument("Users", userId, "/", updatedUser);
    return updatedUser;
  } catch (error) {
    console.error("Error updating presence:", error.message);
    return null;
  }
}

async function notifyPresenceToContacts(userId, payload, sendJson) {
  const contactIds = await getChatContactIds(userId);
  contactIds.forEach((contactId) => {
    const contactSocket = getUserSocket(contactId);
    if (contactSocket) {
      sendJson(contactSocket, payload);
    }
  });
}

async function handleTypingEvent(ws, payload, sendJson, eventType) {
  const chatId = normalizeString(payload.chatId);
  const receiverId = normalizeAccountId(payload.receiverId);

  if (!chatId || !receiverId) {
    sendJson(ws, {
      type: `${eventType}_failed`,
      message: "chatId and receiverId are required.",
    });
    return;
  }

  const receiverSocket = getUserSocket(receiverId);
  if (receiverSocket) {
    sendJson(receiverSocket, {
      type: eventType,
      chatId,
      userId: ws.userId,
    });
  }

  sendJson(ws, {
    type: `${eventType}_ack`,
    chatId,
    receiverId,
    receiverOnline: Boolean(receiverSocket),
  });
}

async function getPresenceForUsers(userIds) {
  const normalizedIds = [...new Set(userIds.map(normalizeAccountId).filter(Boolean))];
  const presenceList = await Promise.all(
    normalizedIds.map(async (userId) => {
      const userDoc = await readUser(userId);
      return {
        userId,
        isOnline: isUserOnline(userId),
        lastSeen: userDoc && typeof userDoc.lastSeen === "number"
          ? userDoc.lastSeen
          : null,
      };
    }),
  );

  return presenceList;
}

async function getChatContactIds(userId) {
  try {
    const chatsListDoc = await firestoreManager.readDocument("ChatsList", userId, "/");
    const chatList = chatsListDoc && Array.isArray(chatsListDoc.list)
      ? chatsListDoc.list
      : [];

    return chatList
      .map(getChatIdFromChatListItem)
      .map((chatId) => getOtherUserIdFromChatId(chatId, userId))
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

async function readUser(userId) {
  try {
    return (await firestoreManager.readDocument("Users", userId, "/")) || null;
  } catch (error) {
    return null;
  }
}

function getChatIdFromChatListItem(chatListItem) {
  if (typeof chatListItem === "string") {
    return chatListItem;
  }
  if (!chatListItem || typeof chatListItem !== "object") {
    return "";
  }
  return chatListItem.chatId || chatListItem.id || chatListItem._id || "";
}

function getOtherUserIdFromChatId(chatId, userId) {
  if (!chatId) {
    return "";
  }

  const normalizedUserId = normalizePhoneNumberForChatId(userId);
  return chatId
    .split("_")
    .filter(Boolean)
    .find((chatUserId) => normalizePhoneNumberForChatId(chatUserId) !== normalizedUserId) || "";
}

function normalizeAccountId(value) {
  const normalized = normalizeString(value);
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
  return normalizeString(value).replace("<plus>", "").replace(/^\+/, "");
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

module.exports = {
  getPresenceForUsers,
  handleTypingEvent,
  markUserOffline,
  markUserOnline,
  notifyPresenceToContacts,
};
