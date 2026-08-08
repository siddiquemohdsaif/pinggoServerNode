const express = require("express");
const FirestoreManager = require("../Firestore/FirestoreManager");
const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();

router.post("/list", async (req, res) => {
  try {
    const phoneNumber = normalizeString(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );

    const validationError = validatePhoneNumber({ phoneNumber });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const userDoc = await getChatsListByPhoneNumber(accountId);

    if (userDoc) {
      const userProfiles = await getOtherUserProfilesFromChatList(
        userDoc.list,
        phoneNumber,
      );

      return res.status(200).json({
        success: true,
        chatList: userDoc.list,
        userProfiles,
      });
    }

    return res.status(404).json({ success: false, message: "No user found." });
  } catch (error) {
    console.error("Error in login:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/getChat", async (req, res) => {
  try {
    const phoneNumber = normalizeString(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );

    const validationError = validatePhoneNumber({ phoneNumber });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chatId = req.body.chatId;

    if (!chatId) {
      return res
        .status(400)
        .json({ success: false, message: "Chat Id missing" });
    }

    const chatDoc = await getSingleChatByChatId(chatId);

    if (chatDoc) {
      const userProfile = await getOtherUserProfileFromChatId(
        chatId,
        phoneNumber,
      );

      return res.status(200).json({
        success: true,
        chat: chatDoc,
        userProfile,
      });
    }

    return res.status(404).json({ success: false, message: "No user found." });
  } catch (error) {
    console.error("Error in login:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/sync", async (req, res) => {
  try {
    const phoneNumber = normalizeString(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const lastSyncTime = Number(req.body.lastSyncTime || 0);

    const validationError = validateSyncRequest({ phoneNumber, lastSyncTime });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const chatsListDoc = await getChatsListByPhoneNumber(accountId);
    if (!chatsListDoc) {
      return res.status(200).json({
        success: true,
        messages: [],
        syncTime: Date.now(),
      });
    }

    const chatIds = getChatIdsFromChatList(chatsListDoc.list);
    const chatDocs = await Promise.all(
      chatIds.map(async (chatId) => ({
        chatId,
        chat: await getSingleChatByChatId(chatId),
      })),
    );

    const normalizedAccountId = normalizePhoneNumberForChatId(accountId);
    const messages = chatDocs
      .flatMap(({ chatId, chat }) =>
        getMessagesFromChatDocument(
          chat,
          chatId,
          normalizedAccountId,
          lastSyncTime,
        ),
      )
      .sort((a, b) => a.sentTime - b.sentTime);

    return res.status(200).json({
      success: true,
      messages,
      syncTime: Date.now(),
    });
  } catch (error) {
    console.error("Error in sync:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

async function getChatsListByPhoneNumber(phoneNumber) {
  try {
    const userDoc = await firestoreManager.readDocument(
      "ChatsList",
      phoneNumber,
      "/",
    );
    return userDoc || false;
  } catch (error) {
    return false;
  }
}

async function getSingleChatByChatId(chatId) {
  try {
    const userDoc = await firestoreManager.readDocument("Chats", chatId, "/");
    return userDoc || false;
  } catch (error) {
    return false;
  }
}

async function getUserByPhoneNumber(phoneNumber) {
  try {
    const userDoc = await firestoreManager.readDocument(
      "Users",
      phoneNumber,
      "/",
    );
    return userDoc || false;
  } catch (error) {
    return false;
  }
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function formatPhoneNumberForAccountId(phoneNumber) {
  if (phoneNumber.startsWith("+")) {
    return `<plus>${phoneNumber.slice(1)}`;
  }
  return phoneNumber;
}

function normalizePhoneNumberForChatId(phoneNumber) {
  if (!phoneNumber) {
    return "";
  }

  return phoneNumber.replace("<plus>", "").replace(/^\+/, "");
}

function getOtherPhoneNumberFromChatId(chatId, phoneNumber) {
  if (typeof chatId !== "string") {
    return "";
  }

  const accountPhoneNumber = normalizePhoneNumberForChatId(phoneNumber);
  const phoneNumbers = chatId.split("_").filter(Boolean);
  return (
    phoneNumbers.find(
      (chatPhoneNumber) =>
        normalizePhoneNumberForChatId(chatPhoneNumber) !== accountPhoneNumber,
    ) || ""
  );
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

function getChatIdsFromChatList(chatList) {
  if (!Array.isArray(chatList)) {
    return [];
  }

  return chatList.map(getChatIdFromChatListItem).filter(Boolean);
}

function getMessagesFromChatDocument(
  chat,
  chatId,
  normalizedAccountId,
  lastSyncTime,
) {
  if (!chat || typeof chat !== "object") {
    return [];
  }

  return Object.values(chat)
    .filter((value) =>
      isChatMessageForSync(value, normalizedAccountId, lastSyncTime),
    )
    .map((message) => ({
      ...message,
      chatId: message.chatId || chatId,
    }));
}

function isChatMessageForSync(value, normalizedAccountId, lastSyncTime) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!value.id || typeof value.sentTime !== "number") {
    return false;
  }
  if (value.sentTime <= lastSyncTime) {
    return false;
  }

  const senderId = normalizePhoneNumberForChatId(value.senderId);
  const receiverId = normalizePhoneNumberForChatId(value.receiverId);

  return senderId === normalizedAccountId || receiverId === normalizedAccountId;
}

async function getOtherUserProfileFromChatId(chatId, phoneNumber) {
  const otherPhoneNumber = getOtherPhoneNumberFromChatId(chatId, phoneNumber);
  if (!otherPhoneNumber) {
    return null;
  }

  return getUserProfileSummary(otherPhoneNumber);
}

async function getOtherUserProfilesFromChatList(chatList, phoneNumber) {
  if (!Array.isArray(chatList)) {
    return [];
  }

  const profilePromises = chatList.map(async (chatListItem) => {
    const chatId = getChatIdFromChatListItem(chatListItem);
    const userProfile = await getOtherUserProfileFromChatId(
      chatId,
      phoneNumber,
    );

    return {
      chatId,
      ...(userProfile || {
        phoneNumber: getOtherPhoneNumberFromChatId(chatId, phoneNumber),
        profilePhotoUrl: null,
      }),
    };
  });

  return Promise.all(profilePromises);
}

async function getUserProfileSummary(phoneNumber) {
  const normalizedPhoneNumber = normalizePhoneNumberForChatId(phoneNumber);
  const userDoc =
    (await getUserByPhoneNumber(`<plus>${normalizedPhoneNumber}`)) ||
    (await getUserByPhoneNumber(normalizedPhoneNumber)) ||
    (await getUserByPhoneNumber(phoneNumber));

  const profileData = userDoc && userDoc.profileData ? userDoc.profileData : {};
  return {
    phoneNumber:
      normalizePhoneNumberForChatId(profileData.phoneNumber) ||
      normalizedPhoneNumber,
    profilePhotoUrl: profileData.profilePhotoUrl || null,
    isOnline: userDoc.isOnline || false,
    lastSeen: userDoc.lastSeen || Date.now(),
  };
}

function validatePhoneNumber({ phoneNumber }) {
  if (!phoneNumber) {
    return "phoneNumber is required.";
  }

  if (!/^\+?[0-9]{7,15}$/.test(phoneNumber)) {
    return "phoneNumber must contain 7 to 15 digits and may start with +.";
  }

  return null;
}

function validateSyncRequest({ phoneNumber, lastSyncTime }) {
  const phoneError = validatePhoneNumber({ phoneNumber });
  if (phoneError) {
    return phoneError;
  }
  if (!Number.isFinite(lastSyncTime) || lastSyncTime < 0) {
    return "lastSyncTime must be a non-negative number.";
  }
  return null;
}

module.exports = router;
