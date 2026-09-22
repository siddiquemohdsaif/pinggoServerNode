const FirestoreManager = require("../Firestore/FirestoreManager");
const { chatEntries } = require("../utils/chatMembership");
const { sendToUser, isUserOnline } = require("./connectionManager");

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
    sendToUser(contactId, payload, sendJson);
  });
}

async function notifyProfileUpdatedToContacts(userId, profileData) {
  const normalizedUserId = normalizeAccountId(userId);
  if (!normalizedUserId) return;
  const profile = profileData && typeof profileData === "object" ? profileData : {};
  const payload = {
    type: "user_profile_updated",
    userId: normalizedUserId,
    name: normalizeString(profile.name || profile.displayName),
    profilePhotoUrl: normalizeString(profile.profilePhotoUrl),
    updatedAt: Date.now(),
  };
  const directChats = await getDirectChatContacts(normalizedUserId);
  await Promise.all(directChats.map(({ chatId, contactId }) =>
    updateContactChatListProfile(contactId, chatId, payload)));
  const recipients = new Set(directChats.map(({ contactId }) => contactId));
  // Keep other devices signed into the same account synchronized too.
  recipients.add(normalizedUserId);
  recipients.forEach((recipientId) => sendToUser(recipientId, payload,
    (socket, event) => {
      if (socket.readyState === undefined || socket.readyState === 1) {
        try { socket.send(JSON.stringify(event)); } catch (_error) {}
      }
    }));
}

async function updateContactChatListProfile(contactId, chatId, profile) {
  try {
    const document = await firestoreManager.readDocument("ChatsList", contactId, "/");
    const list = chatEntries(document);
    const existing = list[chatId];
    if (!existing) return;
    const updated = {
      ...existing,
      serverProfileName: profile.name,
      server_profile_name: profile.name,
      profilePhotoUrl: profile.profilePhotoUrl || null,
      profile_photo_url: profile.profilePhotoUrl || null,
      profile_updated_at: profile.updatedAt,
    };
    await firestoreManager.updateDocument("ChatsList", contactId, "/", {
      [chatId]: updated,
    });
  } catch (error) {
    console.error("Could not synchronize profile into ChatsList:", error.message);
  }
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

  const receiverOnline = isUserOnline(receiverId);
  if (receiverOnline) {
    sendToUser(receiverId, {
      type: eventType,
      chatId,
      userId: ws.userId,
    }, sendJson);
  }

  sendJson(ws, {
    type: `${eventType}_ack`,
    chatId,
    receiverId,
    receiverOnline,
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
  return (await getDirectChatContacts(userId)).map(({ contactId }) => contactId);
}

async function getDirectChatContacts(userId) {
  try {
    const chatsListDoc = await firestoreManager.readDocument("ChatsList", userId, "/");
    return Object.keys(chatEntries(chatsListDoc))
      .filter((chatId) => !chatId.startsWith("grp_"))
      .map((chatId) => ({ chatId,
        contactId: getOtherUserIdFromChatId(chatId, userId) }))
      .filter(({ contactId }) => Boolean(contactId));
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
  return normalizePhoneNumberForChatId(value);
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
  notifyProfileUpdatedToContacts,
};
