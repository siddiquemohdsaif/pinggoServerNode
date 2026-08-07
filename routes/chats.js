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

router.post("/addMessage", async (req, res) => {
  try {
    const chatId = req.body.chatId;
    const senderId = req.body.senderId;
    const receiverId = req.body.receiverId;
    const text = req.body.text;
    const repliedMessageId = req.body.repliedMessageId;

    const validationError = validateSendMessage({
      chatId,
      senderId,
      receiverId,
      text,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const currentTime = Date.now();
    const message = {
      id: currentTime + "_" + senderId,
      senderId,
      receiverId,
      text,
      sentTime: currentTime,
      deliveredTime: null,
      readTime: null,
    };
    if (repliedMessageId) {
      message.repliedMessageId = repliedMessageId;
    }
    const userDoc = await addMessageByChatId(chatId, message);

    if (userDoc) {
      return res.status(200).json({
        success: true,
        messageID: message.id,
      });
    }

    return res.status(404).json({ success: false, message: "No user found." });
  } catch (error) {
    console.error("Error in login:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/editMessage", async (req, res) => {
  try {
    const chatId = req.body.chatId;
    const messageId = req.body.messageId || req.body.id;
    const senderId = req.body.senderId;
    const text = req.body.text;

    const validationError = validateMessageRequest({
      chatId,
      messageId,
      senderId,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (typeof text !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "text is required." });
    }

    const chat = await getSingleChatByChatId(chatId);
    if (!chat) {
      return res
        .status(404)
        .json({ success: false, message: "No chat found." });
    }

    const existingMessage = chat[messageId];
    if (!existingMessage) {
      return res
        .status(404)
        .json({ success: false, message: "No message found." });
    }

    if (existingMessage.senderId !== senderId) {
      return res
        .status(403)
        .json({ success: false, message: "Sender is not allowed." });
    }

    const updatedMessage = {
      ...existingMessage,
      text,
      editedTime: Date.now(),
    };

    const userDoc = await updateMessageByChatId(
      chatId,
      messageId,
      updatedMessage,
    );

    if (userDoc) {
      return res.status(200).json({
        success: true,
        messageId: messageId,
      });
    }

    return res.status(404).json({ success: false, message: "No chat found." });
  } catch (error) {
    console.error("Error in editMessage:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/deleteMessage", async (req, res) => {
  try {
    const chatId = req.body.chatId;
    const messageId = req.body.messageId || req.body.id;
    const senderId = req.body.senderId;

    const validationError = validateMessageRequest({
      chatId,
      messageId,
      senderId,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chat = await getSingleChatByChatId(chatId);
    if (!chat) {
      return res
        .status(404)
        .json({ success: false, message: "No chat found." });
    }

    const existingMessage = chat[messageId];
    if (!existingMessage) {
      return res
        .status(404)
        .json({ success: false, message: "No message found." });
    }

    if (existingMessage.senderId !== senderId) {
      return res
        .status(403)
        .json({ success: false, message: "Sender is not allowed." });
    }

    const deletedMessage = {
      ...existingMessage,
      _text: existingMessage.text,
      text: "This Message was deleted",
      deletedTime: Date.now(),
    };

    const userDoc = await updateMessageByChatId(
      chatId,
      messageId,
      deletedMessage,
    );

    if (userDoc) {
      return res.status(200).json({
        success: true,
        message: deletedMessage,
      });
    }

    return res.status(404).json({ success: false, message: "No chat found." });
  } catch (error) {
    console.error("Error in deleteMessage:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/deleteOpponentMessage", async (req, res) => {
  try {
    const chatId = req.body.chatId;
    const messageId = req.body.messageId || req.body.id;

    const validationError = validateOpponentDeleteRequest({
      chatId,
      messageId,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chat = await getSingleChatByChatId(chatId);
    if (!chat) {
      return res
        .status(404)
        .json({ success: false, message: "No chat found." });
    }

    const existingMessage = chat[messageId];
    if (!existingMessage) {
      return res
        .status(404)
        .json({ success: false, message: "No message found." });
    }

    const hiddenMessage = {
      ...existingMessage,
      visible: "gone",
    };

    const userDoc = await updateMessageByChatId(
      chatId,
      messageId,
      hiddenMessage,
    );

    if (userDoc) {
      return res.status(200).json({
        success: true,
        messageId,
      });
    }

    return res.status(404).json({ success: false, message: "No chat found." });
  } catch (error) {
    console.error("Error in deleteOpponentMessage:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/replyMessage", async (req, res) => {
  try {
    const chatId = req.body.chatId;
    const messageId = req.body.messageId || req.body.id;
    const senderId = req.body.senderId;
    const receiverId = req.body.receiverId;
    const text = req.body.text;
    const repliedMessageId = req.body.repliedMessageId;

    const validationError = validateReplyMessageRequest({
      chatId,
      repliedMessageId,
    });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chat = await getSingleChatByChatId(chatId);
    if (!chat) {
      return res
        .status(404)
        .json({ success: false, message: "No chat found." });
    }

    if (!chat[repliedMessageId]) {
      return res
        .status(404)
        .json({ success: false, message: "No replied message found." });
    }

    if (!messageId) {
      const sendValidationError = validateSendMessage({
        chatId,
        senderId,
        receiverId,
        text,
      });
      if (sendValidationError) {
        return res
          .status(400)
          .json({ success: false, message: sendValidationError });
      }

      const currentTime = Date.now();
      const replyMessage = {
        id: currentTime + "_" + senderId,
        senderId,
        receiverId,
        text,
        repliedMessageId,
        sentTime: currentTime,
        deliveredTime: null,
        readTime: null,
      };
      const userDoc = await addMessageByChatId(chatId, replyMessage);

      if (userDoc) {
        return res.status(200).json({
          success: true,
          messageID: replyMessage.id,
          repliedMessageId,
        });
      }

      return res
        .status(404)
        .json({ success: false, message: "No chat found." });
    }

    const existingMessage = chat[messageId];
    if (!existingMessage) {
      return res
        .status(404)
        .json({ success: false, message: "No message found." });
    }

    const updatedMessage = {
      ...existingMessage,
      repliedMessageId,
    };

    const userDoc = await updateMessageByChatId(
      chatId,
      messageId,
      updatedMessage,
    );

    if (userDoc) {
      return res.status(200).json({
        success: true,
        messageId,
        repliedMessageId,
      });
    }

    return res.status(404).json({ success: false, message: "No chat found." });
  } catch (error) {
    console.error("Error in replyMessage:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/deliveredMessage", async (req, res) => {
  try {
    const chatId = req.body.chatId;
    const messageIds = req.body.messageIds || req.body.messageIdList;

    const validationError = validateMessageIdsRequest({ chatId, messageIds });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chat = await getSingleChatByChatId(chatId);
    if (!chat) {
      return res
        .status(404)
        .json({ success: false, message: "No chat found." });
    }

    const missingMessageId = findMissingMessageId(chat, messageIds);
    if (missingMessageId) {
      return res.status(404).json({
        success: false,
        message: `No message found: ${missingMessageId}`,
      });
    }

    const deliveredTime = Date.now();
    const userDoc = await updateMessagesByChatId(
      chatId,
      buildMessagesWithTime(chat, messageIds, "deliveredTime", deliveredTime),
    );

    if (userDoc) {
      return res.status(200).json({
        success: true,
        messageIds,
        deliveredTime,
      });
    }

    return res.status(404).json({ success: false, message: "No chat found." });
  } catch (error) {
    console.error("Error in deliveredMessage:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/seenMessage", async (req, res) => {
  try {
    const chatId = req.body.chatId;
    const messageIds = req.body.messageIds || req.body.messageIdList;

    const validationError = validateMessageIdsRequest({ chatId, messageIds });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chat = await getSingleChatByChatId(chatId);
    if (!chat) {
      return res
        .status(404)
        .json({ success: false, message: "No chat found." });
    }

    const missingMessageId = findMissingMessageId(chat, messageIds);
    if (missingMessageId) {
      return res.status(404).json({
        success: false,
        message: `No message found: ${missingMessageId}`,
      });
    }

    const readTime = Date.now();
    const userDoc = await updateMessagesByChatId(
      chatId,
      buildMessagesWithTime(chat, messageIds, "readTime", readTime),
    );

    if (userDoc) {
      return res.status(200).json({
        success: true,
        messageIds,
        readTime,
      });
    }

    return res.status(404).json({ success: false, message: "No chat found." });
  } catch (error) {
    console.error("Error in seenMessage:", error.message);
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
    const userDoc = await firestoreManager.readDocument("Users", phoneNumber, "/");
    return userDoc || false;
  } catch (error) {
    return false;
  }
}

async function addMessageByChatId(chatId, message) {
  try {
    const userDoc = await firestoreManager.updateDocument(
      "Chats",
      chatId,
      "/",
      {
        [message.id]: message,
      },
    );

    return userDoc || false;
  } catch (error) {
    return false;
  }
}

async function updateMessageByChatId(chatId, messageId, message) {
  try {
    const userDoc = await firestoreManager.updateDocument(
      "Chats",
      chatId,
      "/",
      {
        [messageId]: message,
      },
    );

    return userDoc || false;
  } catch (error) {
    return false;
  }
}

async function updateMessagesByChatId(chatId, messages) {
  try {
    const userDoc = await firestoreManager.updateDocument(
      "Chats",
      chatId,
      "/",
      messages,
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

function validateMessageRequest({ chatId, messageId, senderId }) {
  if (!chatId) {
    return "chatId is required.";
  }

  if (!messageId) {
    return "messageId is required.";
  }

  if (!senderId) {
    return "senderId is required.";
  }

  return null;
}

function validateOpponentDeleteRequest({ chatId, messageId }) {
  if (!chatId) {
    return "chatId is required.";
  }

  if (!messageId) {
    return "messageId is required.";
  }

  return null;
}

function validateReplyMessageRequest({ chatId, repliedMessageId }) {
  if (!chatId) {
    return "chatId is required.";
  }

  if (!repliedMessageId) {
    return "repliedMessageId is required.";
  }

  return null;
}

function validateMessageIdsRequest({ chatId, messageIds }) {
  if (!chatId) {
    return "chatId is required.";
  }

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return "messageIds must be a non-empty array.";
  }

  if (messageIds.some((messageId) => !messageId)) {
    return "messageIds must not contain empty values.";
  }

  return null;
}

function validateSendMessage({ chatId, senderId, receiverId, text }) {
  if (!chatId) {
    return "chatId is required.";
  }

  if (!senderId) {
    return "senderId is required.";
  }

  if (!receiverId) {
    return "receiverId is required.";
  }

  if (!text) {
    return "text is required.";
  }

  return null;
}

function findMissingMessageId(chat, messageIds) {
  return messageIds.find((messageId) => !chat[messageId]);
}

function buildMessagesWithTime(chat, messageIds, fieldName, time) {
  return messageIds.reduce((messages, messageId) => {
    messages[messageId] = {
      ...chat[messageId],
      [fieldName]: time,
    };
    return messages;
  }, {});
}
module.exports = router;
