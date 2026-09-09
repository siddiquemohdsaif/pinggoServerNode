const FirestoreManager = require("../Firestore/FirestoreManager");
const { getUserSocket, isUserViewingChat } = require("./connectionManager");
const { sendOfflineMessageNotification } = require("./fcmService");
const { isBlockedBy } = require("../utils/blockUtils");
const { decodeMessageType, forStorage, chatForInternal } = require("../utils/messageTypes");
const { nextTimestamp } = require("../utils/timestampId");
const { ensureShardedContainer, readShardedMap, upsertShardedEntries } = require("../models/ShardedDocumentStore");
const { ensureAccountCollections } = require("../models/AccountStore");

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
  let messageType;
  try {
    messageType = decodeMessageType(payload.messageType);
  } catch (_error) {
    sendMessageFailed(ws, sendJson, { clientMessageId, chatId,
      message: "messageType must be a recognized integer code from 0 through 12." });
    return;
  }
  const attachmentId = normalizeString(payload.attachmentId);
  const attachmentWidth = positiveInteger(payload.attachmentWidth);
  const attachmentHeight = positiveInteger(payload.attachmentHeight);
  const attachmentDurationMs = positiveInteger(payload.attachmentDurationMs);
  const attachmentOrientation = attachmentWidth && attachmentHeight
    ? (attachmentHeight > attachmentWidth ? "portrait" : "landscape")
    : normalizeString(payload.attachmentOrientation).toLowerCase();
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
  if (await isBlockedBy(senderId, receiverId)) {
    sendMessageFailed(ws, sendJson, { clientMessageId, chatId,
      message: "Unblock this contact to send a message." });
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
      const suppressed = await isBlockedBy(receiverId, senderId);
      if (suppressed) await updateLastMessage(senderId, chatId, existingMessage).catch(() => null);
      else await updateLastMessageForParticipants(existingMessage).catch(() => null);
      sendJson(ws, {
        type: "message_ack",
        clientMessageId,
        messageId: existingMessage.id,
        chatId,
        status: "sent",
        sentTime: existingMessage.sentTime,
        message: forStorage(existingMessage),
      });
      return;
    }
  }

  let attachment = null;
  if (["image", "video", "audio", "file"].includes(messageType)) {
    try {
      attachment = await firestoreManager.readDocument(attachmentCollection(chatId), attachmentId, "/");
    } catch (_error) {
      attachment = null;
    }
    if (!attachment || attachment.chatId !== chatId || normalizeAccountId(attachment.uploaderId) !== senderId || attachment.status !== "pending" || attachment.kind !== messageType) {
      sendMessageFailed(ws, sendJson, { clientMessageId, chatId, message: "Attachment is invalid or unavailable." });
      return;
    }
  }

  const sentTime = nextTimestamp();
  const messageId = String(sentTime);
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
      ...(attachmentWidth ? { width: attachmentWidth } : {}),
      ...(attachmentHeight ? { height: attachmentHeight } : {}),
      ...(["portrait", "landscape"].includes(attachmentOrientation)
        ? { orientation: attachmentOrientation } : {}),
      ...(messageType === "video" && attachmentDurationMs
        ? { durationMs: attachmentDurationMs } : {}),
    };
  }
  if (messageType === "location") message.location = location;

  try {
    const suppressedForReceiver = await isBlockedBy(receiverId, senderId);
    await ensureChatReadyForMessage(chatId, senderId, receiverId);
    await saveMessage(chatId, message);
    if (suppressedForReceiver) {
      message.invisible = [receiverId];
      await saveMessage(chatId, message);
      await updateLastMessage(senderId, chatId, message);
    } else {
      await updateLastMessageForParticipants(message);
    }
    const receiverTotalUnread = suppressedForReceiver ? null
      : await incrementUnreadCount(receiverId, chatId).catch(() => null);
    if (attachment) {
      const updatedAttachment = { ...attachment, status: "attached", messageId, attachedTime: sentTime };
      delete updatedAttachment._id;
      firestoreManager
        .updateDocument(attachmentCollection(chatId), attachmentId, "/", updatedAttachment)
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
      message: forStorage(message),
    });

    if (!suppressedForReceiver && receiverSocket) {
      sendJson(receiverSocket, {
        type: "new_message",
        message: forStorage(message),
        ...(receiverTotalUnread === null
          ? {}
          : { total_unread: receiverTotalUnread }),
      });
    }
    if (!suppressedForReceiver && !isUserViewingChat(receiverId, chatId)) {
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
  const markAll = payload.markAll === true;
  let messageIds = payload.messageIds || payload.messageIdList;

  const validationError = markAll
    ? (!chatId ? "Chat id is required." : null)
    : validateMessageIdsRequest({ chatId, messageIds });
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

  if (markAll) {
    const authenticatedUserId = normalizePhoneNumberForChatId(ws.userId);
    messageIds = Object.entries(chat)
      .filter(([, message]) => {
        return message &&
          normalizePhoneNumberForChatId(message.receiverId) === authenticatedUserId &&
          (message.readTime === null || message.readTime === undefined);
      })
      .map(([messageId]) => messageId);
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

  if (messageIds.length > 0) {
    await updateMessages(chatId, updatedMessages);
  }
  const latestSeenMessage = latestMessage(Object.values(updatedMessages));
  if (latestSeenMessage) {
    await updateLastMessageForParticipants(latestSeenMessage);
  }
  const totalUnread = await clearUnreadCount(ws.userId, chatId)
    .catch(() => null);

  sendJson(ws, {
    type: "message_seen_ack",
    chatId,
    messageIds,
    readTime,
    status: "seen",
    ...(totalUnread === null ? {} : { total_unread: totalUnread }),
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
    message: forStorage(updatedMessage),
  });

  notifyMessageReceiver({
    receiverId: updatedMessage.receiverId,
    payload: {
      type: "message_edited",
      chatId,
      messageId,
      text,
      editedTime,
      message: forStorage(updatedMessage),
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

  if (isDeletedMessage(existingMessage)) {
    const invisible = addInvisibleNumber(existingMessage.invisible, ws.userId);
    const alreadyInvisible = invisible.length === invisibleNumbers(existingMessage.invisible).length;
    if (!alreadyInvisible) {
      await updateMessages(chatId, {
        [messageId]: { ...existingMessage, invisible },
      });
    }
    sendJson(ws, {
      type: "delete_message_ack", chatId, messageId,
      deletedTime: existingMessage.deletedTime || null,
      message: forStorage({ ...existingMessage, invisible }), hidden: true,
      skipped: alreadyInvisible,
    });
    return;
  }

  const deletedTime = Date.now();
  const deletedMessage = {
    ...existingMessage,
    deletedText: existingMessage.text,
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
    message: forStorage(deletedMessage),
  });

  notifyMessageReceiver({
    receiverId: deletedMessage.receiverId,
    payload: {
      type: "message_deleted",
      chatId,
      messageId,
      deletedTime,
      message: forStorage(deletedMessage),
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

  const invisible = addInvisibleNumber(existingMessage.invisible, ws.userId);
  const alreadyInvisible = invisible.length === invisibleNumbers(existingMessage.invisible).length;
  if (alreadyInvisible) {
    sendJson(ws, {
      type: "delete_opponent_message_ack", chatId, messageId, skipped: true,
    });
    return;
  }

  const hiddenMessage = {
    ...existingMessage,
    invisible,
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

async function handleDeleteMessages(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageIds = normalizedMessageIds(payload.messageIds);
  const senderId = normalizeAccountId(payload.senderId || ws.userId);
  const validationError = validateMessageIdsRequest({ chatId, messageIds });
  if (validationError || senderId !== ws.userId) {
    sendJson(ws, {
      type: "delete_messages_failed", chatId: chatId || null,
      message: validationError || "senderId must match authenticated user.",
    });
    return;
  }
  const chat = await getChat(chatId);
  const invalidId = messageIds.find((id) => !chat || !chat[id]
    || normalizeAccountId(chat[id].senderId) !== ws.userId);
  if (invalidId) {
    sendJson(ws, { type: "delete_messages_failed", chatId,
      message: `Message missing or not owned by sender: ${invalidId}` });
    return;
  }
  const pendingMessageIds = messageIds.filter((id) => !isDeletedMessage(chat[id]));
  const hiddenMessageIds = messageIds.filter((id) => isDeletedMessage(chat[id])
    && !includesInvisibleNumber(chat[id].invisible, ws.userId));
  const skippedMessageIds = messageIds.filter((id) => isDeletedMessage(chat[id])
    && includesInvisibleNumber(chat[id].invisible, ws.userId));
  const deletedTime = Date.now();
  const updates = {};
  pendingMessageIds.forEach((id) => {
    updates[id] = { ...chat[id], deletedText: chat[id].text,
      text: "This Message was deleted", deletedTime };
  });
  hiddenMessageIds.forEach((id) => {
    updates[id] = { ...chat[id],
      invisible: addInvisibleNumber(chat[id].invisible, ws.userId) };
  });
  if (Object.keys(updates).length > 0) await updateMessages(chatId, updates);
  sendJson(ws, { type: "delete_messages_ack", chatId, messageIds,
    updatedMessageIds: [...pendingMessageIds, ...hiddenMessageIds],
    hiddenMessageIds: [...hiddenMessageIds, ...skippedMessageIds],
    skippedMessageIds, deletedTime });
  pendingMessageIds.forEach((messageId) => notifyMessageReceiver({
    receiverId: updates[messageId].receiverId,
    payload: { type: "message_deleted", chatId, messageId, deletedTime,
      message: forStorage(updates[messageId]) },
    sendJson,
  }));
}

async function handleDeleteOpponentMessages(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageIds = normalizedMessageIds(payload.messageIds);
  const validationError = validateMessageIdsRequest({ chatId, messageIds });
  if (validationError) {
    sendJson(ws, { type: "delete_opponent_messages_failed", chatId: chatId || null,
      message: validationError });
    return;
  }
  const chat = await getChat(chatId);
  const invalidId = messageIds.find((id) => !chat || !chat[id]
    || !isMessageParticipant(chat[id], ws.userId));
  if (invalidId) {
    sendJson(ws, { type: "delete_opponent_messages_failed", chatId,
      message: `Message missing or user is not a participant: ${invalidId}` });
    return;
  }
  const pendingMessageIds = messageIds.filter((id) =>
    !includesInvisibleNumber(chat[id].invisible, ws.userId));
  const skippedMessageIds = messageIds.filter((id) =>
    includesInvisibleNumber(chat[id].invisible, ws.userId));
  if (pendingMessageIds.length > 0) {
    const updates = {};
    pendingMessageIds.forEach((id) => {
      updates[id] = { ...chat[id],
        invisible: addInvisibleNumber(chat[id].invisible, ws.userId) };
    });
    await updateMessages(chatId, updates);
  }
  sendJson(ws, { type: "delete_opponent_messages_ack", chatId, messageIds,
    updatedMessageIds: pendingMessageIds, skippedMessageIds });
}

async function handlePinMessages(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageIds = normalizedMessageIds(payload.messageIds);
  const validationError = validateMessageIdsRequest({ chatId, messageIds });
  if (validationError) {
    sendJson(ws, { type: "pin_messages_failed", chatId: chatId || null,
      message: validationError });
    return;
  }
  const chat = await getChat(chatId);
  const invalidId = messageIds.find((id) => !chat || !chat[id]
    || !isMessageParticipant(chat[id], ws.userId));
  if (invalidId) {
    sendJson(ws, { type: "pin_messages_failed", chatId,
      message: `Message missing or user is not a participant: ${invalidId}` });
    return;
  }
  const pendingMessageIds = messageIds.filter((id) =>
    !pinnedMessageUsers(chat[id]).includes(ws.userId));
  const skippedMessageIds = messageIds.filter((id) =>
    pinnedMessageUsers(chat[id]).includes(ws.userId));
  const pinnedAt = Date.now();
  const updates = {};
  const pinStates = {};
  pendingMessageIds.forEach((id) => {
    const pinned = [...new Set([...pinnedMessageUsers(chat[id]), ws.userId])];
    updates[id] = { ...chat[id], pinned, pinned_at: pinnedAt };
    pinStates[id] = { pinned, pinned_at: pinnedAt };
  });
  if (pendingMessageIds.length > 0) await updateMessages(chatId, updates);
  const result = { chatId, messageIds: pendingMessageIds,
    requestedMessageIds: messageIds, updatedMessageIds: pendingMessageIds,
    skippedMessageIds, pinned_by: ws.userId, pin_states: pinStates,
    pinned_at: pendingMessageIds.length > 0 ? pinnedAt : null };
  sendJson(ws, { type: "pin_messages_ack", ...result });
  const participants = new Set();
  pendingMessageIds.forEach((id) => {
    participants.add(normalizeAccountId(chat[id].senderId));
    participants.add(normalizeAccountId(chat[id].receiverId));
  });
  participants.delete(ws.userId);
  participants.forEach((userId) => {
    const socket = getUserSocket(userId);
    if (socket) sendJson(socket, { type: "messages_pinned", ...result });
  });
}

async function handleUnpinMessages(ws, payload, sendJson) {
  const chatId = normalizeString(payload.chatId);
  const messageIds = normalizedMessageIds(payload.messageIds);
  const validationError = validateMessageIdsRequest({ chatId, messageIds });
  if (validationError) {
    sendJson(ws, { type: "unpin_messages_failed", chatId: chatId || null,
      message: validationError });
    return;
  }
  const chat = await getChat(chatId);
  const invalidId = messageIds.find((id) => !chat || !chat[id]
    || !isMessageParticipant(chat[id], ws.userId));
  if (invalidId) {
    sendJson(ws, { type: "unpin_messages_failed", chatId,
      message: `Message missing or user is not a participant: ${invalidId}` });
    return;
  }
  const pendingMessageIds = messageIds.filter((id) =>
    pinnedMessageUsers(chat[id]).includes(ws.userId)
      || (isPinnedMessage(chat[id]) && pinnedMessageUsers(chat[id]).length === 0));
  const skippedMessageIds = messageIds.filter((id) =>
    !pendingMessageIds.includes(id));
  const updates = {};
  const pinStates = {};
  pendingMessageIds.forEach((id) => {
    const pinned = pinnedMessageUsers(chat[id]).filter((userId) => userId !== ws.userId);
    const pinnedAt = pinned.length > 0 ? chat[id].pinned_at || null : null;
    updates[id] = { ...chat[id], pinned, pinned_at: pinnedAt };
    pinStates[id] = { pinned, pinned_at: pinnedAt };
  });
  if (pendingMessageIds.length > 0) await updateMessages(chatId, updates);
  const result = { chatId, messageIds: pendingMessageIds,
    requestedMessageIds: messageIds, updatedMessageIds: pendingMessageIds,
    skippedMessageIds, pinned_by: ws.userId, pin_states: pinStates, pinned_at: null };
  sendJson(ws, { type: "unpin_messages_ack", ...result });
  const participants = new Set();
  pendingMessageIds.forEach((id) => {
    participants.add(normalizeAccountId(chat[id].senderId));
    participants.add(normalizeAccountId(chat[id].receiverId));
  });
  participants.delete(ws.userId);
  participants.forEach((userId) => {
    const socket = getUserSocket(userId);
    if (socket) sendJson(socket, { type: "messages_unpinned", ...result });
  });
}

async function handleForwardMessages(ws, payload, sendJson) {
  const sourceChatId = normalizeString(payload.sourceChatId);
  const destinationChatId = normalizeString(payload.destinationChatId);
  const messageIds = normalizedMessageIds(payload.messageIds);
  const senderId = normalizeAccountId(payload.senderId || ws.userId);
  const receiverId = normalizeAccountId(payload.receiverId);
  const operationId = normalizeString(payload.operationId);
  const validationError = validateMessageIdsRequest({ chatId: sourceChatId, messageIds });
  if (validationError || !operationId || senderId !== ws.userId || !receiverId
      || !validChatParticipants(destinationChatId, senderId, receiverId)) {
    sendJson(ws, { type: "forward_messages_failed", sourceChatId: sourceChatId || null,
      destinationChatId: destinationChatId || null,
      message: validationError || (!operationId
        ? "operationId is required."
        : senderId !== ws.userId
        ? "senderId must match authenticated user."
        : "Forward destination is invalid.") });
    return;
  }
  if (await isBlockedBy(senderId, receiverId)) {
    sendJson(ws, { type: "forward_messages_failed", sourceChatId,
      destinationChatId, message: "Unblock this contact to send a message." });
    return;
  }
  const sourceChat = await getChat(sourceChatId);
  const invalidId = messageIds.find((id) => !sourceChat || !sourceChat[id]
    || !isMessageParticipant(sourceChat[id], ws.userId));
  if (invalidId) {
    sendJson(ws, { type: "forward_messages_failed", sourceChatId, destinationChatId,
      message: `Message missing or user is not a participant: ${invalidId}` });
    return;
  }
  const destinationBeforeForward = await getChat(destinationChatId);
  const existingBySourceId = new Map(
    Object.values(destinationBeforeForward || {})
      .filter((message) => message && message.forward_operation_id === operationId
        && normalizeAccountId(message.senderId) === senderId)
      .map((message) => [normalizeString(message.forwarded_message_id), message]),
  );
  await ensureChatReadyForMessage(destinationChatId, senderId, receiverId);
  const skippedMessageIds = messageIds.filter((sourceId) =>
    existingBySourceId.has(sourceId) || isDeletedMessage(sourceChat[sourceId]));
  const pendingMessageIds = messageIds.filter((sourceId) =>
    !existingBySourceId.has(sourceId) && !isDeletedMessage(sourceChat[sourceId]));
  const newMessages = pendingMessageIds.map((sourceId) => {
    const source = sourceChat[sourceId];
    const sentTime = nextTimestamp();
    const forwarded = {
      id: String(sentTime), clientMessageId: null, chatId: destinationChatId,
      senderId, receiverId, text: normalizeString(source.text),
      messageType: normalizeString(source.messageType || "text").toLowerCase(),
      sentTime, deliveredTime: null, readTime: null, status: "sent",
      forwarded_from: normalizeAccountId(source.forwarded_from || source.senderId),
      forwarded_message_id: sourceId,
      forward_operation_id: operationId,
    };
    if (source.attachment) forwarded.attachment = { ...source.attachment };
    if (source.location) forwarded.location = { ...source.location };
    return forwarded;
  });
  const suppressedForReceiver = await isBlockedBy(receiverId, senderId);
  if (suppressedForReceiver) {
    for (const message of newMessages) message.invisible = [receiverId];
  }
  if (newMessages.length > 0) {
    await updateMessages(destinationChatId,
      Object.fromEntries(newMessages.map((message) => [message.id, message])));
  }
  for (const message of newMessages) {
    if (suppressedForReceiver) await updateLastMessage(senderId, destinationChatId, message);
    else await updateLastMessageForParticipants(message);
  }
  let receiverTotalUnread = null;
  for (const _message of suppressedForReceiver ? [] : newMessages) {
    receiverTotalUnread = await incrementUnreadCount(receiverId, destinationChatId)
      .catch(() => receiverTotalUnread);
  }
  const messages = messageIds
    .map((sourceId) => existingBySourceId.get(sourceId)
      || newMessages.find((message) => message.forwarded_message_id === sourceId))
    .filter(Boolean);
  sendJson(ws, { type: "forward_messages_ack", sourceChatId, destinationChatId,
    operationId, messages, forwardedMessageIds: pendingMessageIds, skippedMessageIds });
  const receiverSocket = getUserSocket(receiverId);
  for (let index = 0; !suppressedForReceiver && index < newMessages.length; index += 1) {
    const message = newMessages[index];
    if (receiverSocket) sendJson(receiverSocket, {
      type: "new_message", message: forStorage(message),
      ...(index === newMessages.length - 1 && receiverTotalUnread !== null
        ? { total_unread: receiverTotalUnread } : {}),
    });
    if (!isUserViewingChat(receiverId, destinationChatId)) {
      sendFcmWithoutFailingMessage({ receiverId, message });
    }
  }
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

  const pendingMessageIds = messageIds.filter((messageId) => {
    const message = chat[messageId];
    return !message.deliveredTime && !message.readTime;
  });
  const deliveredTime = Date.now();
  const updatedMessages = pendingMessageIds.reduce((updates, messageId) => {
    updates[messageId] = {
      ...chat[messageId],
      deliveredTime,
      status: chat[messageId].readTime ? "seen" : "delivered",
    };
    return updates;
  }, {});

  if (pendingMessageIds.length) {
    await updateMessages(chatId, updatedMessages);
  }

  // ChatsList stores a denormalized last_message. Synchronize it on every request,
  // including duplicate delivery acknowledgements, so stale list data is repaired.
  const receiptMessages = messageIds.map((messageId) =>
    updatedMessages[messageId] || chat[messageId]).filter(Boolean);
  const latestDeliveredMessage = latestMessage(receiptMessages);
  if (latestDeliveredMessage) {
    await updateLastMessageForParticipants(latestDeliveredMessage);
  }

  sendJson(ws, {
    type: "message_delivered_ack",
    chatId,
    messageIds,
    deliveredTime,
    status: "delivered",
  });

  if (pendingMessageIds.length) {
    notifyMessageSenders({
      chat,
      messageIds: pendingMessageIds,
      payload: {
        type: "message_delivered",
        chatId,
        messageIds: pendingMessageIds,
        deliveredTime,
        status: "delivered",
      },
      sendJson,
    });
  }
}

async function saveMessage(chatId, message) {
  const result = await upsertShardedEntries(chatCollection(chatId), chatId, {
    [message.id]: forStorage(message),
  });

  if (!result) {
    throw new Error("Message could not be saved.");
  }

  return result;
}

async function saveCallMessage({ callId, chatId, callerId, receiverId, mediaType, text,
  callerText, receiverText,
  durationSeconds, createdAt, ringingAt, connectedAt, endedAt, terminationReason,
  suppressedForReceiver = false }, sendJson) {
  if (!callId || !chatId || !callerId || !receiverId || !text) return null;
  const existingChat = await getChat(chatId);
  const existingMessage = existingChat && Object.values(existingChat).find((item) =>
    item && item.callId === callId &&
      item.messageType === (mediaType === "video" ? "video_call" : "voice_call"),
  );
  if (existingMessage) {
    if (suppressedForReceiver) {
      await updateLastMessage(callerId, chatId, {
        ...existingMessage, text: existingMessage.callerText || existingMessage.text,
      }).catch(() => null);
    } else {
      await updateLastMessageForParticipants(existingMessage).catch(() => null);
    }
    return existingMessage;
  }
  const sentTime = nextTimestamp();
  const message = {
    id: String(sentTime), clientMessageId: null, callId, chatId,
    senderId: callerId, receiverId, text,
    callerText: callerText || text, receiverText: receiverText || text,
    messageType: mediaType === "video" ? "video_call" : "voice_call",
    callDurationSeconds: durationSeconds, callCreatedAt: createdAt || null,
    callRingingAt: ringingAt || null, callConnectedAt: connectedAt || null,
    callEndedAt: endedAt || null, callTerminationReason: terminationReason || "unknown",
    sentTime, deliveredTime: null,
    readTime: null, status: "sent",
    invisible: suppressedForReceiver ? [receiverId] : [],
  };
  await ensureChatReadyForMessage(
    chatId, callerId, receiverId, !suppressedForReceiver,
  );
  await saveMessage(chatId, message);
  if (suppressedForReceiver) {
    await updateLastMessage(callerId, chatId, {
      ...message, text: message.callerText || message.text,
    });
  } else {
    await updateLastMessageForParticipants(message);
  }
  const receiverTotalUnread = suppressedForReceiver ? null
    : await incrementUnreadCount(receiverId, chatId).catch(() => null);
  const visibleUsers = suppressedForReceiver ? [callerId] : [callerId, receiverId];
  for (const userId of visibleUsers) {
    const socket = getUserSocket(userId);
    const participantMessage = { ...message,
      text: userId === callerId ? message.callerText : message.receiverText };
    if (socket) sendJson(socket, {
      type: "new_message",
      message: forStorage(participantMessage),
      ...(userId === receiverId && receiverTotalUnread !== null
        ? { total_unread: receiverTotalUnread }
        : {}),
    });
  }
  // Call notifications are emitted by callHandler so completed calls never
  // appear as ordinary message notifications.
  return message;
}

async function ensureChatReadyForMessage(chatId, senderId, receiverId, includeReceiver = true) {
  const chat = await getChat(chatId);
  if (!chat) {
    await createChatDocument(chatId);
  }

  const accountIds = includeReceiver ? [senderId, receiverId] : [senderId];
  await Promise.all(accountIds.map(ensureAccountCollections));
  const participants = [addChatIdToChatsList(senderId, chatId)];
  if (includeReceiver) participants.push(addChatIdToChatsList(receiverId, chatId));
  await Promise.all(participants);
}

async function createChatDocument(chatId) {
  if (chatCollection(chatId) === "GroupsChat") {
    await ensureShardedContainer("GroupsChat", chatId, "messages");
    return;
  }
  await Promise.all([
    ensureShardedContainer("Chats", chatId, "messages"),
    ensureShardedContainer("CallLogs", chatId, "calls"),
  ]);
}

async function addChatIdToChatsList(userId, chatId) {
  const accountId = normalizeAccountId(userId);
  const existingDoc = await getChatsList(accountId);
  const existingList = existingDoc && existingDoc.list;
  const list = Array.isArray(existingList)
    ? Object.fromEntries(existingList.map((id) => [id, defaultChatSettings()]))
    : existingList && typeof existingList === "object"
      ? existingList
      : {};
  if (Object.prototype.hasOwnProperty.call(list, chatId)) {
    return;
  }

  const updatedDoc = {
    ...withoutDocumentId(existingDoc || {}),
    list: { ...list, [chatId]: defaultChatSettings() },
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

function defaultChatSettings() {
  return {
    pinned: false,
    notification_muted: "0",
    archieved: false,
    unread_count: 0,
    last_message: null,
  };
}

async function updateLastMessageForParticipants(message) {
  await Promise.all([
    updateLastMessage(message.senderId, message.chatId, {
      ...message, text: message.callerText || message.text,
    }),
    updateLastMessage(message.receiverId, message.chatId, {
      ...message, text: message.receiverText || message.text,
    }),
  ]);
}

function latestMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages.reduce((latest, message) => {
    if (!message) return latest;
    if (!latest) return message;
    return Number(message.sentTime) >= Number(latest.sentTime) ? message : latest;
  }, null);
}

async function updateLastMessage(userId, chatId, message) {
  const accountId = normalizeAccountId(userId);
  const existingDoc = await getChatsList(accountId);
  if (!existingDoc) return;
  const existingList = existingDoc.list;
  const list = Array.isArray(existingList)
    ? Object.fromEntries(existingList.map((id) => [id, defaultChatSettings()]))
    : existingList && typeof existingList === "object"
      ? existingList
      : {};
  const settings = { ...defaultChatSettings(), ...(list[chatId] || {}) };
  const currentLastMessage = settings.last_message;
  if (
    currentLastMessage &&
    Number(currentLastMessage.sentTime) > Number(message.sentTime)
  ) {
    return;
  }
  settings.last_message = forStorage(message);
  await firestoreManager.updateDocument("ChatsList", accountId, "/", {
    ...withoutDocumentId(existingDoc),
    list: { ...list, [chatId]: settings },
  });
}

async function incrementUnreadCount(userId, chatId) {
  return updateUnreadCount(userId, chatId, (current) => current + 1);
}

async function clearUnreadCount(userId, chatId) {
  return updateUnreadCount(userId, chatId, () => 0);
}

async function updateUnreadCount(userId, chatId, updater) {
  const accountId = normalizeAccountId(userId);
  const existingDoc = await getChatsList(accountId);
  if (!existingDoc) return;
  const existingList = existingDoc.list;
  const list = Array.isArray(existingList)
    ? Object.fromEntries(existingList.map((id) => [id, defaultChatSettings()]))
    : existingList && typeof existingList === "object"
      ? existingList
      : {};
  const settings = { ...defaultChatSettings(), ...(list[chatId] || {}) };
  const current = Number(settings.unread_count) || 0;
  settings.unread_count = Math.max(0, updater(current));
  const updatedList = { ...list, [chatId]: settings };
  await firestoreManager.updateDocument("ChatsList", accountId, "/", {
    ...withoutDocumentId(existingDoc),
    list: updatedList,
  });
  return Object.values(updatedList).reduce((total, chatSettings) =>
    total + (Number(chatSettings && chatSettings.unread_count) > 0 ? 1 : 0), 0);
}

function withoutDocumentId(document) {
  const copy = { ...document };
  delete copy._id;
  return copy;
}

async function getChat(chatId) {
  try {
    const stored = await readShardedMap(chatCollection(chatId), chatId);
    if (!stored) return null;
    return chatForInternal(stored);
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
  const storedMessages = Object.fromEntries(Object.entries(messages || {}).map(
    ([key, value]) => [key, forStorage(value)],
  ));
  const result = await upsertShardedEntries(chatCollection(chatId), chatId, storedMessages);
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
  if (!["text", "image", "video", "audio", "file", "location"].includes(messageType)) {
    return "messageType must be text, image, video, audio, file, or location.";
  }
  if (messageType === "text" && !text) {
    return "text is required.";
  }
  if (["image", "video", "audio", "file"].includes(messageType) && !attachmentId) {
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

function normalizedMessageIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeString).filter(Boolean))];
}

function isMessageParticipant(message, userId) {
  const accountId = normalizeAccountId(userId);
  return Boolean(message) && [message.senderId, message.receiverId]
    .map(normalizeAccountId).includes(accountId);
}

function isDeletedMessage(message) {
  return Boolean(message) && (message.deletedText != null
    || message.text === "This Message was deleted"
    || message.deletedTime != null);
}

function isPinnedMessage(message) {
  return Boolean(message) && (pinnedMessageUsers(message).length > 0
    || message.pinned === true || message.pinned === "true");
}

function pinnedMessageUsers(message) {
  if (!message || !Array.isArray(message.pinned)) return [];
  return [...new Set(message.pinned.map(normalizeAccountId).filter(Boolean))];
}

function invisibleNumbers(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeAccountId).filter(Boolean))];
}

function includesInvisibleNumber(values, userId) {
  return invisibleNumbers(values).includes(normalizeAccountId(userId));
}

function addInvisibleNumber(values, userId) {
  const numbers = invisibleNumbers(values);
  const accountId = normalizeAccountId(userId);
  if (accountId && !numbers.includes(accountId)) numbers.push(accountId);
  return numbers;
}

function validChatParticipants(chatId, firstUserId, secondUserId) {
  if (!chatId) return false;
  const participants = chatId.split("_").map(normalizeAccountId);
  return participants.includes(normalizeAccountId(firstUserId))
    && participants.includes(normalizeAccountId(secondUserId));
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

function chatCollection(chatId) {
  return normalizeString(chatId).startsWith("grp_") ? "GroupsChat" : "Chats";
}

function attachmentCollection(chatId) {
  return normalizeString(chatId).startsWith("grp_")
    ? "GroupAttachments"
    : "ChatAttachments";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

module.exports = {
  handleDeleteMessages,
  handleDeleteMessage,
  handleDeleteOpponentMessages,
  handleDeleteOpponentMessage,
  handleDeliveredMessage,
  handleEditMessage,
  handleForwardMessages,
  handlePinMessages,
  handleUnpinMessages,
  handleSendMessage,
  handleSeenMessage,
  saveCallMessage,
};
