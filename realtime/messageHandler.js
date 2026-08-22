const FirestoreManager = require("../Firestore/FirestoreManager");
const { getUserSocket } = require("./connectionManager");
const { sendOfflineMessageNotification } = require("./fcmService");

const firestoreManager = FirestoreManager.getInstance();

async function handleSendMessage(ws, payload, sendJson) {
  const clientMessageId = normalizeString(
    payload.clientMessageId || payload.localMessageId,
  );
  const chatId = normalizeString(payload.chatId);
  const senderId = normalizeAccountId(payload.senderId);
  const receiverId = normalizeAccountId(payload.receiverId);
  const text = normalizeString(payload.text);
  const repliedMessageId = normalizeString(payload.repliedMessageId);
  const messageType = normalizeString(payload.messageType || "text").toLowerCase();
  const attachmentId = normalizeString(payload.attachmentId);
  const location = normalizeLocation(payload.location);

  const validationError = validateSendMessage({
    chatId,
    senderId,
    receiverId,
    text,
    messageType,
    attachmentId,
    location,
  });
  if (validationError) {
    sendMessageFailed(ws, sendJson, {
      clientMessageId,
      chatId,
      message: validationError,
    });
    return;
  }

  if (senderId !== ws.userId) {
    sendMessageFailed(ws, sendJson, {
      clientMessageId,
      chatId,
      message: "senderId must match authenticated user.",
    });
    return;
  }

  // A client retains send_message until it receives message_ack. If the socket
  // drops after persistence but before the ack arrives, acknowledge the
  // existing record instead of creating a duplicate or rejecting its now-used
  // attachment.
  if (clientMessageId) {
    const existingChat = await getChat(chatId);
    const existingMessage = existingChat && Object.values(existingChat).find((item) =>
      item && item.clientMessageId === clientMessageId
      && normalizeAccountId(item.senderId) === senderId,
    );
    if (existingMessage) {
      sendJson(ws, {
        type: "message_ack",
        clientMessageId,
        messageId: existingMessage.id,
        chatId,
        status: "sent",
        sentTime: existingMessage.sentTime,
        message: existingMessage,
      });
      return;
    }
  }

  let attachment = null;
  if (["image", "video", "file"].includes(messageType)) {
    try {
      attachment = await firestoreManager.readDocument("ChatAttachments", attachmentId, "/");
    } catch (_error) {
      attachment = null;
    }
    if (!attachment || attachment.chatId !== chatId || normalizeAccountId(attachment.uploaderId) !== senderId || attachment.status !== "pending" || attachment.kind !== messageType) {
      sendMessageFailed(ws, sendJson, { clientMessageId, chatId, message: "Attachment is invalid or unavailable." });
      return;
    }
  }

  const sentTime = Date.now();
  const messageId = `${sentTime}_${senderId}`;
  const message = {
    id: messageId,
    clientMessageId: clientMessageId || null,
    chatId,
    senderId,
    receiverId,
    text,
    messageType,
    sentTime,
    deliveredTime: null,
    readTime: null,
    status: "sent",
  };

  if (repliedMessageId) {
    message.repliedMessageId = repliedMessageId;
  }
  if (attachment) {
    message.attachment = {
      id: attachment.id || attachmentId,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      url: attachment.url,
    };
  }
  if (messageType === "location") message.location = location;

  try {
    await ensureChatReadyForMessage(chatId, senderId, receiverId);
    await saveMessage(chatId, message);
    if (attachment) {
      const updatedAttachment = { ...attachment, status: "attached", messageId, attachedTime: sentTime };
      delete updatedAttachment._id;
      firestoreManager
        .updateDocument("ChatAttachments", attachmentId, "/", updatedAttachment)
        .catch(() => null);
    }
    const receiverSocket = getUserSocket(receiverId);
    const receiverOnline = Boolean(receiverSocket);

    // Acknowledge the sender as soon as the message is safely stored. Receiver delivery and
    // offline notification are independent and must never keep the sender in "sending" state.
    sendJson(ws, {
      type: "message_ack",
      clientMessageId: clientMessageId || null,
      messageId,
      chatId,
      status: "sent",
      sentTime,
      receiverOnline,
      message,
    });

    if (receiverSocket) {
      sendJson(receiverSocket, {
        type: "new_message",
        message,
      });
    } else {
      sendFcmWithoutFailingMessage({ receiverId, message });
    }
  } catch (error) {
    sendMessageFailed(ws, sendJson, {
      clientMessageId,
      chatId,
      message: error.message,
    });
  }
}

async function sendFcmWithoutFailingMessage({ receiverId, message }) {
  try {
    return await sendOfflineMessageNotification({ receiverId, message });
  } catch (error) {
    return {
      success: false,
      skipped: false,
      reason: error.message,
    };
  }
}

async function handleSeenMessage(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageIds = payload.messageIds || payload.messageIdList;

  const validationError = validateMessageIdsRequest({ chatId, messageIds });
  if (validationError) {
    sendJson(ws, {
      type: "message_seen_failed",
      chatId: chatId || null,
      message: validationError,
    });
    return;
  }

  const chat = await getChat(chatId);
  if (!chat) {
    sendJson(ws, {
      type: "message_seen_failed",
      chatId,
      message: "No chat found.",
    });
    return;
  }

  const missingMessageId = messageIds.find((messageId) => !chat[messageId]);
  if (missingMessageId) {
    sendJson(ws, {
      type: "message_seen_failed",
      chatId,
      message: `No message found: ${missingMessageId}`,
    });
    return;
  }

  const unauthorizedMessageId = messageIds.find((messageId) => {
    return (
      normalizePhoneNumberForChatId(chat[messageId].receiverId) !==
      normalizePhoneNumberForChatId(ws.userId)
    );
  });
  if (unauthorizedMessageId) {
    sendJson(ws, {
      type: "message_seen_failed",
      chatId,
      message: `Authenticated user cannot mark message seen: ${unauthorizedMessageId}`,
    });
    return;
  }

  const readTime = Date.now();
  const updatedMessages = messageIds.reduce((updates, messageId) => {
    updates[messageId] = {
      ...chat[messageId],
      readTime,
      status: "seen",
    };
    return updates;
  }, {});

  await updateMessages(chatId, updatedMessages);

  sendJson(ws, {
    type: "message_seen_ack",
    chatId,
    messageIds,
    readTime,
    status: "seen",
  });

  notifyMessageSenders({
    chat,
    messageIds,
    payload: {
      type: "message_seen",
      chatId,
      messageIds,
      readTime,
      status: "seen",
    },
    sendJson,
  });
}

async function handleEditMessage(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageId = normalizeString(payload.messageId);
  const senderId = normalizeAccountId(payload.senderId || ws.userId);
  const text = normalizeString(payload.text);

  const validationError = validateEditMessage({
    chatId,
    messageId,
    senderId,
    text,
  });
  if (validationError) {
    sendJson(ws, {
      type: "edit_message_failed",
      chatId: chatId || null,
      messageId: messageId || null,
      message: validationError,
    });
    return;
  }

  if (senderId !== ws.userId) {
    sendJson(ws, {
      type: "edit_message_failed",
      chatId,
      messageId,
      message: "senderId must match authenticated user.",
    });
    return;
  }

  const chat = await getChat(chatId);
  if (!chat || !chat[messageId]) {
    sendJson(ws, {
      type: "edit_message_failed",
      chatId,
      messageId,
      message: "No message found.",
    });
    return;
  }

  const existingMessage = chat[messageId];
  if (normalizeAccountId(existingMessage.senderId) !== senderId) {
    sendJson(ws, {
      type: "edit_message_failed",
      chatId,
      messageId,
      message: "Sender not allowed.",
    });
    return;
  }

  const editedTime = Date.now();
  const updatedMessage = {
    ...existingMessage,
    text,
    editedTime,
  };

  await updateMessages(chatId, {
    [messageId]: updatedMessage,
  });

  sendJson(ws, {
    type: "edit_message_ack",
    chatId,
    messageId,
    text,
    editedTime,
    message: updatedMessage,
  });

  notifyMessageReceiver({
    receiverId: updatedMessage.receiverId,
    payload: {
      type: "message_edited",
      chatId,
      messageId,
      text,
      editedTime,
      message: updatedMessage,
    },
    sendJson,
  });
}

async function handleDeleteMessage(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageId = normalizeString(payload.messageId);
  const senderId = normalizeAccountId(payload.senderId || ws.userId);

  const validationError = validateDeleteMessage({
    chatId,
    messageId,
    senderId,
  });
  if (validationError) {
    sendJson(ws, {
      type: "delete_message_failed",
      chatId: chatId || null,
      messageId: messageId || null,
      message: validationError,
    });
    return;
  }

  if (senderId !== ws.userId) {
    sendJson(ws, {
      type: "delete_message_failed",
      chatId,
      messageId,
      message: "senderId must match authenticated user.",
    });
    return;
  }

  const chat = await getChat(chatId);
  if (!chat || !chat[messageId]) {
    sendJson(ws, {
      type: "delete_message_failed",
      chatId,
      messageId,
      message: "No message found.",
    });
    return;
  }

  const existingMessage = chat[messageId];
  if (normalizeAccountId(existingMessage.senderId) !== senderId) {
    sendJson(ws, {
      type: "delete_message_failed",
      chatId,
      messageId,
      message: "Sender not allowed.",
    });
    return;
  }

  const deletedTime = Date.now();
  const deletedMessage = {
    ...existingMessage,
    text: "This Message was deleted",
    deletedTime,
  };

  await updateMessages(chatId, {
    [messageId]: deletedMessage,
  });

  sendJson(ws, {
    type: "delete_message_ack",
    chatId,
    messageId,
    deletedTime,
    message: deletedMessage,
  });

  notifyMessageReceiver({
    receiverId: deletedMessage.receiverId,
    payload: {
      type: "message_deleted",
      chatId,
      messageId,
      deletedTime,
      message: deletedMessage,
    },
    sendJson,
  });
}

async function handleDeleteOpponentMessage(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageId = normalizeString(payload.messageId);

  const validationError = validateOpponentDeleteMessage({ chatId, messageId });
  if (validationError) {
    sendJson(ws, {
      type: "delete_opponent_message_failed",
      chatId: chatId || null,
      messageId: messageId || null,
      message: validationError,
    });
    return;
  }

  const chat = await getChat(chatId);
  if (!chat || !chat[messageId]) {
    sendJson(ws, {
      type: "delete_opponent_message_failed",
      chatId,
      messageId,
      message: "No message found.",
    });
    return;
  }

  const existingMessage = chat[messageId];
  const senderId = normalizeAccountId(existingMessage.senderId);
  const receiverId = normalizeAccountId(existingMessage.receiverId);
  if (ws.userId !== senderId && ws.userId !== receiverId) {
    sendJson(ws, {
      type: "delete_opponent_message_failed",
      chatId,
      messageId,
      message: "Authenticated user is not a chat participant.",
    });
    return;
  }

  const hiddenMessage = {
    ...existingMessage,
    visible: "gone",
  };

  await updateMessages(chatId, {
    [messageId]: hiddenMessage,
  });

  sendJson(ws, {
    type: "delete_opponent_message_ack",
    chatId,
    messageId,
  });
}

async function handleDeliveredMessage(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageIds = payload.messageIds || payload.messageIdList;

  const validationError = validateMessageIdsRequest({ chatId, messageIds });
  if (validationError) {
    sendJson(ws, {
      type: "message_delivered_failed",
      chatId: chatId || null,
      message: validationError,
    });
    return;
  }

  const chat = await getChat(chatId);
  if (!chat) {
    sendJson(ws, {
      type: "message_delivered_failed",
      chatId,
      message: "No chat found.",
    });
    return;
  }

  const missingMessageId = messageIds.find((messageId) => !chat[messageId]);
  if (missingMessageId) {
    sendJson(ws, {
      type: "message_delivered_failed",
      chatId,
      message: `No message found: ${missingMessageId}`,
    });
    return;
  }

  const unauthorizedMessageId = messageIds.find((messageId) => {
    return (
      normalizePhoneNumberForChatId(chat[messageId].receiverId) !==
      normalizePhoneNumberForChatId(ws.userId)
    );
  });
  if (unauthorizedMessageId) {
    sendJson(ws, {
      type: "message_delivered_failed",
      chatId,
      message: `Authenticated user cannot mark message delivered: ${unauthorizedMessageId}`,
    });
    return;
  }

  const deliveredTime = Date.now();
  const updatedMessages = messageIds.reduce((updates, messageId) => {
    updates[messageId] = {
      ...chat[messageId],
      deliveredTime,
      status: chat[messageId].readTime ? "seen" : "delivered",
    };
    return updates;
  }, {});

  await updateMessages(chatId, updatedMessages);

  sendJson(ws, {
    type: "message_delivered_ack",
    chatId,
    messageIds,
    deliveredTime,
    status: "delivered",
  });

  notifyMessageSenders({
    chat,
    messageIds,
    payload: {
      type: "message_delivered",
      chatId,
      messageIds,
      deliveredTime,
      status: "delivered",
    },
    sendJson,
  });
}

async function saveMessage(chatId, message) {
  const result = await firestoreManager.updateDocument("Chats", chatId, "/", {
    [message.id]: message,
  });

  if (!result) {
    throw new Error("Message could not be saved.");
  }

  return result;
}

async function saveCallMessage({ callId, chatId, callerId, receiverId, text, durationSeconds }, sendJson) {
  if (!callId || !chatId || !callerId || !receiverId || !text) return null;
  const existingChat = await getChat(chatId);
  const existingMessage = existingChat && Object.values(existingChat).find((item) =>
    item && item.callId === callId && item.messageType === "voice_call",
  );
  if (existingMessage) return existingMessage;
  const sentTime = Date.now();
  const message = {
    id: `call_${callId}`, clientMessageId: null, callId, chatId,
    senderId: callerId, receiverId, text, messageType: "voice_call",
    callDurationSeconds: durationSeconds, sentTime, deliveredTime: null,
    readTime: null, status: "sent",
  };
  await ensureChatReadyForMessage(chatId, callerId, receiverId);
  await saveMessage(chatId, message);
  for (const userId of [callerId, receiverId]) {
    const socket = getUserSocket(userId);
    if (socket) sendJson(socket, { type: "new_message", message });
  }
  if (!getUserSocket(receiverId)) sendFcmWithoutFailingMessage({ receiverId, message });
  return message;
}

async function ensureChatReadyForMessage(chatId, senderId, receiverId) {
  const chat = await getChat(chatId);
  if (!chat) {
    await createChatDocument(chatId);
  }

  await Promise.all([
    addChatIdToChatsList(senderId, chatId),
    addChatIdToChatsList(receiverId, chatId),
  ]);
}

async function createChatDocument(chatId) {
  try {
    await firestoreManager.createDocument("Chats", chatId, "/", {});
  } catch (error) {
    await updateMessages(chatId, {});
  }
}

async function addChatIdToChatsList(userId, chatId) {
  const accountId = normalizeAccountId(userId);
  const existingDoc = await getChatsList(accountId);
  const list = Array.isArray(existingDoc && existingDoc.list)
    ? existingDoc.list
    : [];
  if (list.includes(chatId)) {
    return;
  }

  const updatedDoc = {
    ...withoutDocumentId(existingDoc || {}),
    list: [...list, chatId],
  };

  try {
    if (existingDoc) {
      await firestoreManager.updateDocument("ChatsList", accountId, "/", updatedDoc);
    } else {
      await firestoreManager.createDocument("ChatsList", accountId, "/", updatedDoc);
    }
  } catch (error) {
    await firestoreManager.updateDocument("ChatsList", accountId, "/", updatedDoc);
  }
}

function withoutDocumentId(document) {
  const copy = { ...document };
  delete copy._id;
  return copy;
}

async function getChat(chatId) {
  try {
    return (await firestoreManager.readDocument("Chats", chatId, "/")) || null;
  } catch (error) {
    return null;
  }
}

async function getChatsList(userId) {
  try {
    return (await firestoreManager.readDocument("ChatsList", userId, "/")) || null;
  } catch (error) {
    return null;
  }
}

async function updateMessages(chatId, messages) {
  const result = await firestoreManager.updateDocument(
    "Chats",
    chatId,
    "/",
    messages,
  );
  if (!result) {
    throw new Error("Messages could not be updated.");
  }
  return result;
}

function notifyMessageSenders({ chat, messageIds, payload, sendJson }) {
  const senderIds = new Set(
    messageIds
      .map((messageId) => normalizeAccountId(chat[messageId].senderId))
      .filter(Boolean),
  );

  senderIds.forEach((senderId) => {
    const senderSocket = getUserSocket(senderId);
    if (senderSocket) {
      sendJson(senderSocket, payload);
    }
  });
}

function notifyMessageReceiver({ receiverId, payload, sendJson }) {
  const receiverSocket = getUserSocket(normalizeAccountId(receiverId));
  if (receiverSocket) {
    sendJson(receiverSocket, payload);
  }
}

function sendMessageFailed(ws, sendJson, payload) {
  sendJson(ws, {
    type: "message_failed",
    clientMessageId: payload.clientMessageId || null,
    chatId: payload.chatId || null,
    status: "failed",
    message: payload.message,
  });
}

function validateEditMessage({ chatId, messageId, senderId, text }) {
  if (!chatId) {
    return "chatId is required.";
  }
  if (!messageId) {
    return "messageId is required.";
  }
  if (!senderId) {
    return "senderId is required.";
  }
  if (!text) {
    return "text is required.";
  }
  return null;
}

function validateDeleteMessage({ chatId, messageId, senderId }) {
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

function validateOpponentDeleteMessage({ chatId, messageId }) {
  if (!chatId) {
    return "chatId is required.";
  }
  if (!messageId) {
    return "messageId is required.";
  }
  return null;
}

function validateSendMessage({ chatId, senderId, receiverId, text, messageType, attachmentId, location }) {
  if (!chatId) {
    return "chatId is required.";
  }
  if (!senderId) {
    return "senderId is required.";
  }
  if (!receiverId) {
    return "receiverId is required.";
  }
  if (!["text", "image", "video", "file", "location"].includes(messageType)) {
    return "messageType must be text, image, video, file, or location.";
  }
  if (messageType === "text" && !text) {
    return "text is required.";
  }
  if (["image", "video", "file"].includes(messageType) && !attachmentId) {
    return "attachmentId is required.";
  }
  if (messageType === "location" && !location) {
    return "Valid location coordinates are required.";
  }
  return null;
}

function normalizeLocation(value) {
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const accuracy = value.accuracy == null ? null : Number(value.accuracy);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0))) return null;
  return { latitude, longitude, accuracy };
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
  handleDeleteMessage,
  handleDeleteOpponentMessage,
  handleDeliveredMessage,
  handleEditMessage,
  handleSendMessage,
  handleSeenMessage,
  saveCallMessage,
};
