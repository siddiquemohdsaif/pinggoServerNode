const express = require("express");
const FirestoreManager = require("../Firestore/FirestoreManager");
const { getUserSocket } = require("../realtime/connectionManager");
const { isBlockedBy, setBlocked } = require("../utils/blockUtils");
const { chatForInternal, forStorage } = require("../utils/messageTypes");
const { reportForStorage, reportForInternal } = require("../utils/specializedRecords");
const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();
const groupService = require("../services/groupService");
const { readShardedMap, upsertShardedEntries } = require("../models/ShardedDocumentStore");

router.post("/list", async (req, res) => {
  const routeStartedAt = process.hrtime.bigint();
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const pageSize = normalizePageSize(req.body.pageSize);
    const messageCacheSize = normalizeMessageCacheSize(req.body.messageCacheSize);
    const cursor = decodeCursor(req.body.cursor);

    const validationError = validatePhoneNumber({ phoneNumber });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const chatListReadStartedAt = process.hrtime.bigint();
    const userDoc = await getChatsListByPhoneNumber(accountId);
    console.log(
      `[chats/list] chat-list read completed in ${elapsedMilliseconds(chatListReadStartedAt)} ms`,
    );

    if (userDoc) {
      const page = paginateChatList(userDoc.list, pageSize, cursor);
      const [userProfiles, messageCache] = await Promise.all([
        getOtherUserProfilesFromChatList(page.chatList, phoneNumber),
        getRecentMessageCache(page.chatList, messageCacheSize, phoneNumber),
      ]);

      return res.status(200).json({
        success: true,
        userProfiles,
        messageCache,
        total_unread: countUnreadChats(userDoc.list),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    }

    return res.status(404).json({ success: false, message: "No user found." });
  } catch (error) {
    console.error("Error in login:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  } finally {
    console.log(
      `[chats/list] route completed in ${elapsedMilliseconds(routeStartedAt)} ms` +
        ` with status ${res.statusCode}`,
    );
  }
});

router.post("/getChat", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );

    const validationError = validatePhoneNumber({ phoneNumber });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chatId = req.body.chatId;
    const pageSize = normalizePageSize(req.body.pageSize);
    const cursor = decodeMessageCursor(req.body.cursor);

    if (!chatId) {
      return res
        .status(400)
        .json({ success: false, message: "Chat Id missing" });
    }
    const groupChat = chatId.startsWith("grp_");
    let group = null;
    if (groupChat) {
      group = await groupService.readGroup(chatId);
      try { groupService.requireMember(group, phoneNumber); }
      catch (error) {
        return res.status(error.statusCode || 403).json({ success: false, message: error.message });
      }
    } else if (!chatId.split("_").map(normalizePhoneNumberForChatId).includes(phoneNumber)) {
      return res.status(403).json({ success: false,
        message: "phoneNumber must be a participant in chatId." });
    }

    let chatDoc = await getSingleChatByChatId(chatId);

    if (groupChat && chatDoc) {
      const membership = group.members[normalizePhoneNumberForChatId(phoneNumber)];
      chatDoc = Object.fromEntries(Object.entries(chatDoc).filter(([, message]) =>
        message && groupService.memberCanAccessMessage(membership, phoneNumber, message)));
    }

    if (chatDoc) {
      const userProfile = groupChat ? {
        chatId, chatType: "group", groupId: chatId, groupName: group.name,
        groupDescription: group.description || "", groupIcon: group.icon || null,
        groupMemberCount: Object.values(group.members || {}).filter(
          (member) => member && member.status === "active").length,
        ownGroupRole: group.members[normalizePhoneNumberForChatId(phoneNumber)].role,
        membershipVersion: Number(group.membershipVersion) || 0,
      } : await getOtherUserProfileFromChatId(chatId, phoneNumber);

      const page = paginateChatMessages(chatDoc, chatId, pageSize, cursor, phoneNumber);
      const pinnedMessages = cursor ? [] : getPinnedChatMessages(chatDoc, chatId, phoneNumber);
      return res.status(200).json({
        success: true,
        pinnedMessages: pinnedMessages.map(forStorage),
        messages: page.messages.map(forStorage),
        replyMessages: getReplyMessagesForPage(
          chatDoc,
          chatId,
          [...page.messages, ...pinnedMessages],
          phoneNumber,
        ).map(forStorage),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        userProfile,
      });
    }

    return res.status(404).json({ success: false, message: "No user found." });
  } catch (error) {
    console.error("Error in login:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/media", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(req.body.phoneNumber || req.body.phone);
    const chatId = normalizeString(req.body.chatId);
    const pageSize = Math.min(50, Math.max(1, Number(req.body.pageSize) || 20));
    const before = Number(req.body.before || Number.MAX_SAFE_INTEGER);
    const phoneError = validatePhoneNumber({ phoneNumber });
    if (phoneError || !chatId) return res.status(400).json({ success: false,
      message: phoneError || "chatId is required." });
    if (chatId.startsWith("grp_")) {
      const group = await groupService.readGroup(chatId);
      try { groupService.requireMember(group, phoneNumber); }
      catch (error) { return res.status(error.statusCode || 403).json({ success: false, message: error.message }); }
    } else if (!chatId.split("_").map(normalizePhoneNumberForChatId).includes(phoneNumber)) {
      return res.status(403).json({ success: false, message: "Chat participation required." });
    }
    const chat = await getSingleChatByChatId(chatId);
    if (!chat) return res.status(404).json({ success: false, message: "Chat not found." });
    const media = getPageableMessagesFromChatDocument(chat, chatId, phoneNumber)
      .filter((message) => {
        const type = normalizeString(message.messageType).toLowerCase();
        const hasSupportedAttachment = message.attachment && ["image", "video", "file"].includes(type);
        const hasLink = /https?:\/\/[^\s]+/i.test(normalizeString(message.text));
        return (hasSupportedAttachment || hasLink) && Number(message.sentTime) < before;
      })
      .sort(compareMessageSortEntries).slice(0, pageSize);
    return res.status(200).json({ success: true, media: media.map(forStorage),
      nextCursor: media.length === pageSize ? media[media.length - 1].sentTime : null,
      hasMore: media.length === pageSize });
  } catch (error) { return res.status(400).json({ success: false, message: error.message }); }
});

router.post("/clear", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const chatId = normalizeString(req.body.chatId);
    let validationError = validatePhoneNumber({ phoneNumber });
    if (!validationError && chatId.startsWith("grp_")) {
      try { groupService.requireMember(await groupService.readGroup(chatId), phoneNumber); }
      catch (error) { validationError = error.message; }
    } else if (!validationError) validationError = validateChatParticipant(phoneNumber, chatId);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const chat = await getSingleChatByChatId(chatId);
    if (!chat) return res.status(404).json({ success: false, message: "Chat not found." });

    const updates = {};
    for (const [id, message] of Object.entries(chat)) {
      if (!isStoredMessage(message)) continue;
      updates[id] = forStorage({
        ...message,
        invisible: addInvisibleNumber(message.invisible, phoneNumber),
      });
    }
    if (Object.keys(updates).length > 0) {
      await upsertShardedEntries(chatCollection(chatId), chatId, updates);
    }
    await clearChatListPreview(phoneNumber, chatId);
    pushChatCleared(phoneNumber, chatId);
    return res.status(200).json({ success: true, chatId, cleared: true });
  } catch (error) {
    console.error("Error clearing chat:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/report", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const chatId = normalizeString(req.body.chatId);
    const reason = normalizeString(req.body.reason);
    const validationError = validatePhoneNumber({ phoneNumber }) ||
      validateChatParticipant(phoneNumber, chatId) ||
      (!reason ? "reason is required." : null);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const chat = await getSingleChatByChatId(chatId);
    if (!chat) return res.status(404).json({ success: false, message: "Chat not found." });

    const receiverId = getOtherPhoneNumberFromChatId(chatId, phoneNumber);
    const sentTime = Date.now();
    const messageId = `${sentTime}`;
    const message = {
      id: messageId,
      chatId,
      senderId: phoneNumber,
      receiverId,
      messageType: 9,
      // The client renders this as a system pill, never as a normal message bubble.
      text: `${phoneNumber} reported ${receiverId}`,
      reportReason: reason,
      sentTime,
      status: "sent",
      invisible: [],
    };
    await upsertShardedEntries("Chats", chatId, {
      [messageId]: forStorage(message),
    });

    let reportDocument = null;
    try {
      reportDocument = await firestoreManager.readDocument("Reports", chatId, "/");
    } catch (_error) {
      reportDocument = null;
    }
    const decodedReport = reportDocument ? reportForInternal(reportDocument) : null;
    const reports = decodedReport ? decodedReport.messages : [];
    const storedReport = { messageId, reporterId: phoneNumber, reportedUserId: receiverId,
      reason, createdAt: sentTime };
    const document = reportForStorage({ chatId, messages: [...reports, storedReport] });
    if (reportDocument) {
      await firestoreManager.updateDocument("Reports", chatId, "/", document);
    } else {
      await firestoreManager.createDocument("Reports", chatId, "/", document);
    }
    await Promise.all([
      updateReportLastMessage(phoneNumber, chatId, message),
      updateReportLastMessage(receiverId, chatId, message),
    ]);
    pushNewMessage(phoneNumber, message);
    pushNewMessage(receiverId, message);
    return res.status(200).json({ success: true, chatId, message: forStorage(message) });
  } catch (error) {
    console.error("Error reporting chat:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/block-status", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(req.body.phoneNumber || req.body.phone);
    const chatId = normalizeString(req.body.chatId);
    const validationError = validatePhoneNumber({ phoneNumber }) ||
      validateChatParticipant(phoneNumber, chatId);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const opponentId = getOtherPhoneNumberFromChatId(chatId, phoneNumber);
    return res.status(200).json({ success: true, chatId,
      blocked: await isBlockedBy(phoneNumber, opponentId) });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/block", async (req, res) => changeBlockState(req, res, true));
router.post("/unblock", async (req, res) => changeBlockState(req, res, false));

async function changeBlockState(req, res, blocked) {
  try {
    const phoneNumber = normalizePhoneNumber(req.body.phoneNumber || req.body.phone);
    const chatId = normalizeString(req.body.chatId);
    const validationError = validatePhoneNumber({ phoneNumber }) ||
      validateChatParticipant(phoneNumber, chatId);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const opponentId = getOtherPhoneNumberFromChatId(chatId, phoneNumber);
    const updatedAt = await setBlocked(phoneNumber, opponentId, chatId, blocked);
    pushBlockStatus(phoneNumber, chatId, opponentId, blocked, updatedAt);
    let message = null;
    {
      const action = blocked ? "blocked" : "unblocked";
      const messageId = `${blocked ? "block" : "unblock"}_${updatedAt}_${Math.random().toString(36).slice(2, 10)}`;
      message = { id: messageId, chatId, senderId: phoneNumber, receiverId: opponentId,
        messageType: blocked ? "chat_block" : "chat_unblock",
        text: `${phoneNumber} ${action} ${opponentId}`,
        sentTime: updatedAt, status: "sent", invisible: [] };
      await upsertShardedEntries("Chats", chatId, {
        [messageId]: forStorage(message),
      });
      await Promise.all([
        updateReportLastMessage(phoneNumber, chatId, message),
        updateReportLastMessage(opponentId, chatId, message),
      ]);
      pushNewMessage(phoneNumber, message);
      pushNewMessage(opponentId, message);
    }
    return res.status(200).json({ success: true, chatId, opponentId, blocked,
      message: forStorage(message) });
  } catch (error) {
    console.error(`Error ${blocked ? "blocking" : "unblocking"} chat:`, error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
}

router.post("/settings", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const chatId = normalizeString(req.body.chatId);
    const setting = normalizeString(req.body.setting);
    const value = Number(req.body.value);

    const validationError = validatePhoneNumber({ phoneNumber }) ||
      validateChatSetting({ phoneNumber, chatId, setting, value });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const chatsListDoc = await getChatsListByPhoneNumber(
      formatPhoneNumberForAccountId(phoneNumber),
    );
    const existingList = chatsListDoc && chatsListDoc.list;
    const chatList = Array.isArray(existingList)
      ? Object.fromEntries(existingList.map((id) => [id, defaultChatSettings()]))
      : existingList && typeof existingList === "object" ? existingList : {};
    if (!Object.prototype.hasOwnProperty.call(chatList, chatId)) {
      return res.status(404).json({ success: false, message: "Chat not found in user's list." });
    }

    if (setting === "delete") {
      const updatedList = { ...chatList };
      delete updatedList[chatId];
      await firestoreManager.updateDocument(
        "ChatsList",
        formatPhoneNumberForAccountId(phoneNumber),
        "/",
        { ...withoutDocumentId(chatsListDoc), list: updatedList },
      );
      return res.status(200).json({ success: true, chatId, deleted: true });
    }

    const field = setting === "archive" ? "archieved" :
      setting === "mute" ? "notification_muted" : "pinned";
    const storedValue = setting === "mute" ? value : Boolean(value);
    const settings = {
      ...defaultChatSettings(),
      ...(chatList[chatId] || {}),
      [field]: storedValue,
    };
    const updatedDocument = {
      ...withoutDocumentId(chatsListDoc),
      list: { ...chatList, [chatId]: settings },
    };
    await firestoreManager.updateDocument(
      "ChatsList",
      formatPhoneNumberForAccountId(phoneNumber),
      "/",
      updatedDocument,
    );

    pushChatSetting(phoneNumber, chatId, setting, storedValue);

    return res.status(200).json({ success: true, chatId, settings });
  } catch (error) {
    console.error("Error updating chat settings:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/settings/bulk", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const chatIds = Array.isArray(req.body.chatIds)
      ? [...new Set(req.body.chatIds.map(normalizeString))]
      : null;
    const setting = normalizeString(req.body.setting);
    const value = Number(req.body.value);

    const validationError = validatePhoneNumber({ phoneNumber }) ||
      validateBulkChatSetting({ phoneNumber, chatIds, setting, value });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const chatsListDoc = await getChatsListByPhoneNumber(accountId);
    const existingList = chatsListDoc && chatsListDoc.list;
    const chatList = Array.isArray(existingList)
      ? Object.fromEntries(existingList.map((id) => [id, defaultChatSettings()]))
      : existingList && typeof existingList === "object" ? existingList : {};
    const missingChatIds = chatIds.filter(
      (chatId) => !Object.prototype.hasOwnProperty.call(chatList, chatId),
    );
    if (missingChatIds.length > 0) {
      return res.status(404).json({
        success: false,
        message: "Some chats were not found in user's list.",
        missingChatIds,
      });
    }

    const updatedList = { ...chatList };
    if (setting === "delete") {
      for (const chatId of chatIds) delete updatedList[chatId];
    } else {
      const field = setting === "archive" ? "archieved" :
        setting === "mute" ? "notification_muted" : "pinned";
      const storedValue = setting === "mute" ? value : Boolean(value);
      for (const chatId of chatIds) {
        updatedList[chatId] = {
          ...defaultChatSettings(),
          ...(chatList[chatId] || {}),
          [field]: storedValue,
        };
      }
    }

    await firestoreManager.updateDocument(
      "ChatsList",
      accountId,
      "/",
      { ...withoutDocumentId(chatsListDoc), list: updatedList },
    );
    if (setting !== "delete") {
      const storedValue = setting === "mute" ? value : Boolean(value);
      for (const chatId of chatIds) {
        pushChatSetting(phoneNumber, chatId, setting, storedValue);
      }
    }
    return res.status(200).json({
      success: true,
      chatIds,
      deleted: setting === "delete",
    });
  } catch (error) {
    console.error("Error updating bulk chat settings:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/sync", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
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
        chatList: {},
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
      messages: messages.map(forStorage),
      chatList: chatsListDoc.list || {},
      syncTime: Date.now(),
    });
  } catch (error) {
    console.error("Error in sync:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/discover", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const contacts = Array.isArray(req.body.contacts)
      ? req.body.contacts
      : req.body.phoneNumbers;

    const validationError =
      validatePhoneNumber({ phoneNumber }) || validateDiscoverContacts({ contacts });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const ownPhoneNumber = normalizePhoneNumberForChatId(phoneNumber);
    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const chatsListDoc = await getChatsListByPhoneNumber(accountId);
    const chatList = getChatIdsFromChatList(chatsListDoc && chatsListDoc.list);

    const normalizedContacts = [...new Set(
      contacts
        .map(normalizePhoneNumberForChatId)
        .filter((contactPhoneNumber) =>
          /^\d{7,15}$/.test(contactPhoneNumber) &&
          contactPhoneNumber !== ownPhoneNumber,
        ),
    )];

    const results = await Promise.all(
      normalizedContacts.map(async (contactPhoneNumber) => {
        const profile = await getUserProfileSummary(contactPhoneNumber);
        if (!profile) {
          return {
            phoneNumber: contactPhoneNumber,
            found: false,
          };
        }

        const existingChatId = findChatIdForContact(chatList, contactPhoneNumber);
        const chatId = existingChatId || buildChatId(phoneNumber, contactPhoneNumber);

        return {
          ...profile,
          phoneNumber: contactPhoneNumber,
          found: true,
          chatId,
          isExistingChat: Boolean(existingChatId),
        };
      }),
    );

    return res.status(200).json({
      success: true,
      chatList,
      contacts: results,
      userProfiles: results.filter((contact) => contact.found),
      notFound: results.filter((contact) => !contact.found),
    });
  } catch (error) {
    console.error("Error in discover:", error.message);
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
    const userDoc = await readShardedMap(chatCollection(chatId), chatId);
    return userDoc ? chatForInternal(userDoc) : false;
  } catch (error) {
    return false;
  }
}

function chatCollection(chatId) {
  return String(chatId || "").startsWith("grp_") ? "GroupsChat" : "Chats";
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
  return normalizePhoneNumber(phoneNumber);
}

function normalizePhoneNumberForChatId(phoneNumber) {
  return normalizePhoneNumber(phoneNumber);
}

function normalizePhoneNumber(value) {
  return normalizeString(value).replace(/^<plus>/, "").replace(/^\+/, "");
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

function buildChatId(currentPhoneNumber, otherPhoneNumber) {
  const current = normalizePhoneNumberForChatId(currentPhoneNumber);
  const other = normalizePhoneNumberForChatId(otherPhoneNumber);
  if (!current || !other) {
    return "";
  }
  return `${current}_${other}`;
}

function findChatIdForContact(chatList, phoneNumber) {
  const normalizedPhoneNumber = normalizePhoneNumberForChatId(phoneNumber);
  return (
    chatList.find((chatId) =>
      chatId
        .split("_")
        .some((part) => normalizePhoneNumberForChatId(part) === normalizedPhoneNumber),
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
  if (Array.isArray(chatList)) {
    return chatList.map(getChatIdFromChatListItem).filter(Boolean);
  }
  if (chatList && typeof chatList === "object") {
    return Object.keys(chatList);
  }
  return [];
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
      text: callTextForParticipant(message, normalizedAccountId),
    }));
}

function getPageableMessagesFromChatDocument(chat, chatId, accountId) {
  if (!chat || typeof chat !== "object") return [];
  return Object.entries(chat)
    .filter(([, value]) =>
      value &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "text") &&
      Number.isFinite(Number(value.sentTime)) &&
      (!accountId || isSharedBlockEvent(value) ||
        !includesInvisibleNumber(value.invisible, accountId)),
    )
    .map(([documentKey, message]) => ({
      ...message,
      id: normalizeString(message.id) || documentKey,
      chatId: message.chatId || chatId,
      sentTime: Number(message.sentTime),
      text: callTextForParticipant(message, accountId),
    }));
}

function callTextForParticipant(message, accountId) {
  if (!message || !accountId) return message && message.text;
  const type = normalizeString(message.messageType).toLowerCase();
  if (type !== "voice_call" && type !== "video_call") return message.text;
  const caller = normalizePhoneNumberForChatId(message.senderId);
  const own = caller === normalizePhoneNumberForChatId(accountId);
  return own
    ? (message.callerText || message.text)
    : (message.receiverText || message.text);
}

function compareMessageSortEntries(first, second) {
  if (first.sentTime !== second.sentTime) return second.sentTime - first.sentTime;
  return second.id.localeCompare(first.id);
}

function paginateChatMessages(chat, chatId, pageSize, cursor, accountId) {
  const entries = getPageableMessagesFromChatDocument(chat, chatId, accountId)
    .sort(compareMessageSortEntries);
  const startIndex = cursor
    ? entries.findIndex((entry) => compareMessageSortEntries(entry, cursor) > 0)
    : 0;
  const safeStartIndex = startIndex < 0 ? entries.length : startIndex;
  const pageEntries = entries.slice(safeStartIndex, safeStartIndex + pageSize);
  const hasMore = safeStartIndex + pageEntries.length < entries.length;
  const lastEntry = pageEntries[pageEntries.length - 1];
  return {
    messages: [...pageEntries].reverse(),
    hasMore,
    nextCursor: hasMore && lastEntry
      ? encodeCursor({ sentTime: lastEntry.sentTime, messageId: lastEntry.id })
      : null,
  };
}

function getReplyMessagesForPage(chat, chatId, pageMessages, accountId) {
  if (!Array.isArray(pageMessages) || pageMessages.length === 0) return [];
  const pageIds = new Set(pageMessages
    .map((message) => normalizeString(message && message.id))
    .filter(Boolean));
  const replyIds = new Set(pageMessages
    .map((message) => normalizeString(message && message.repliedMessageId))
    .filter((messageId) => messageId && !pageIds.has(messageId)));
  if (replyIds.size === 0) return [];
  return getPageableMessagesFromChatDocument(chat, chatId, accountId)
    .filter((message) => replyIds.has(message.id));
}

function getPinnedChatMessages(chat, chatId, accountId) {
  return getPageableMessagesFromChatDocument(chat, chatId, accountId)
    .filter((message) => (Array.isArray(message.pinned) && message.pinned.length > 0)
      || message.pinned === true || message.pinned === "true")
    .sort((first, second) => {
      const firstPinnedAt = Number(first.pinned_at || first.pinnedAt || first.sentTime || 0);
      const secondPinnedAt = Number(second.pinned_at || second.pinnedAt || second.sentTime || 0);
      if (firstPinnedAt !== secondPinnedAt) return secondPinnedAt - firstPinnedAt;
      return compareMessageSortEntries(first, second);
    });
}

async function getRecentMessageCache(chatList, cacheSize, accountId) {
  if (cacheSize <= 0) return {};
  const chatIds = getChatIdsFromChatList(chatList);
  if (chatIds.length === 0) return {};
  try {
    const documents = await Promise.all(chatIds.map((chatId) => getSingleChatByChatId(chatId)));
    const chatsById = Object.fromEntries(chatIds.map((chatId, index) =>
      [chatId, documents[index]]));
    return Object.fromEntries(
      chatIds.map((chatId) => [
        chatId,
        chatId.startsWith("grp_") ? [] : paginateChatMessages(
          chatForInternal(chatsById[chatId]), chatId,
          cacheSize, null, accountId).messages.map(forStorage),
      ]),
    );
  } catch (error) {
    console.error("Unable to prefetch recent chat messages:", error.message);
    return {};
  }
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
  if (!isSharedBlockEvent(value) &&
      includesInvisibleNumber(value.invisible, normalizedAccountId)) return false;

  const senderId = normalizePhoneNumberForChatId(value.senderId);
  const receiverId = normalizePhoneNumberForChatId(value.receiverId);

  return senderId === normalizedAccountId || receiverId === normalizedAccountId;
}

function isSharedBlockEvent(message) {
  const type = normalizeString(message && message.messageType).toLowerCase();
  return type === "chat_block" || type === "chat_unblock";
}

async function getOtherUserProfileFromChatId(chatId, phoneNumber) {
  const otherPhoneNumber = getOtherPhoneNumberFromChatId(chatId, phoneNumber);
  if (!otherPhoneNumber) {
    return null;
  }

  return getUserProfileSummary(otherPhoneNumber);
}

async function getOtherUserProfilesFromChatList(chatList, phoneNumber) {
  const chatIds = getChatIdsFromChatList(chatList);
  const groupChatIds = chatIds.filter((chatId) => chatId.startsWith("grp_"));
  const directChatIds = chatIds.filter((chatId) => !chatId.startsWith("grp_"));
  const chatContacts = directChatIds.map((chatId) => ({
    chatId,
    phoneNumber: getOtherPhoneNumberFromChatId(chatId, phoneNumber),
  }));
  const contactPhoneNumbers = [
    ...new Set(chatContacts.map((contact) => contact.phoneNumber).filter(Boolean)),
  ];
  const bulkReadStartedAt = process.hrtime.bigint();
  const users = contactPhoneNumbers.length > 0
    ? await firestoreManager.bulkReadDocuments(
        "Users",
        "/",
        contactPhoneNumbers,
        {},
      )
    : [];
  console.log(
    `[chats/list] bulk Users read completed in ${elapsedMilliseconds(bulkReadStartedAt)} ms` +
      ` (requested=${contactPhoneNumbers.length}, found=${users.length})`,
  );
  const usersByPhoneNumber = new Map(
    users.map((user) => {
      const profilePhoneNumber = normalizePhoneNumberForChatId(
        user && user.profileData && user.profileData.phoneNumber,
      );
      const documentPhoneNumber = normalizePhoneNumberForChatId(user && user._id);
      return [profilePhoneNumber || documentPhoneNumber, user];
    }),
  );

  const directProfiles = chatContacts.map(({ chatId, phoneNumber: contactPhoneNumber }) => {
    const user = usersByPhoneNumber.get(contactPhoneNumber);
    const profileData = user && user.profileData ? user.profileData : {};
    const chatSettings = getChatSettings(chatList, chatId);
    return {
      chatId,
      phoneNumber:
        normalizePhoneNumberForChatId(profileData.phoneNumber) ||
        contactPhoneNumber,
      profilePhotoUrl: profileData.profilePhotoUrl || null,
      isOnline: (user && user.isOnline) || false,
      lastSeen: (user && user.lastSeen) || Date.now(),
      ...chatSettings,
    };
  });
  let groupsById = {};
  if (groupChatIds.length > 0) {
    try {
      groupsById = await firestoreManager.bulkReadDocuments("GroupsList", "/", groupChatIds, {}, true);
    } catch (error) {
      console.error("Unable to read group summaries:", error.message);
    }
  }
  const ownId = normalizePhoneNumberForChatId(phoneNumber);
  const groupProfiles = groupChatIds.map((chatId) => {
    const group = groupsById[chatId] || {};
    const memberMap = group.members && typeof group.members === "object" ? group.members : {};
    const activeMembers = Object.values(memberMap).filter((member) => member && member.status === "active");
    return {
      chatId,
      chatType: "group",
      groupId: chatId,
      groupName: group.name || getChatSettings(chatList, chatId).group_name || "Group",
      groupDescription: group.description || "",
      groupIcon: group.icon || getChatSettings(chatList, chatId).group_icon || null,
      groupMemberCount: activeMembers.length,
      ownGroupRole: memberMap[ownId] && memberMap[ownId].role || "member",
      membershipVersion: Number(group.membershipVersion) || 0,
      ...getChatSettings(chatList, chatId),
    };
  });
  const profilesById = new Map([...directProfiles, ...groupProfiles].map((profile) => [profile.chatId, profile]));
  return chatIds.map((chatId) => profilesById.get(chatId)).filter(Boolean);
}

function getChatSettings(chatList, chatId) {
  const defaults = {
    pinned: false,
    notification_muted: "0",
    archieved: false,
    unread_count: 0,
    last_message: null,
  };
  if (
    !Array.isArray(chatList) &&
    chatList &&
    typeof chatList === "object" &&
    chatList[chatId] &&
    typeof chatList[chatId] === "object"
  ) {
    return { ...defaults, ...chatList[chatId] };
  }
  return defaults;
}

function countUnreadChats(chatList) {
  return getChatIdsFromChatList(chatList).reduce((total, chatId) => {
    const settings = getChatSettings(chatList, chatId);
    return total + (Number(settings.unread_count) > 0 ? 1 : 0);
  }, 0);
}

function normalizePageSize(value) {
  const pageSize = Number(value || 20);
  if (!Number.isInteger(pageSize) || pageSize < 1) return 20;
  return Math.min(pageSize, 50);
}

function normalizeMessageCacheSize(value) {
  if (value === undefined || value === null || value === "") return 0;
  const cacheSize = Number(value);
  if (!Number.isInteger(cacheSize) || cacheSize < 1) return 0;
  return Math.min(cacheSize, 50);
}

function getChatSortEntry(chatId, settings) {
  const normalizedSettings = getChatSettings({ [chatId]: settings }, chatId);
  return {
    chatId,
    settings: normalizedSettings,
    pinned: Boolean(normalizedSettings.pinned),
    sentTime: Number(
      normalizedSettings.last_message && normalizedSettings.last_message.sentTime,
    ) || 0,
  };
}

function compareChatSortEntries(first, second) {
  if (first.pinned !== second.pinned) return first.pinned ? -1 : 1;
  if (first.sentTime !== second.sentTime) return second.sentTime - first.sentTime;
  return first.chatId.localeCompare(second.chatId);
}

function paginateChatList(chatList, pageSize, cursor) {
  const chatIds = getChatIdsFromChatList(chatList);
  const entries = chatIds
    .map((chatId) => getChatSortEntry(
      chatId,
      !Array.isArray(chatList) && chatList ? chatList[chatId] : null,
    ))
    .sort(compareChatSortEntries);
  const startIndex = cursor
    ? entries.findIndex((entry) => compareChatSortEntries(entry, cursor) > 0)
    : 0;
  const safeStartIndex = startIndex < 0 ? entries.length : startIndex;
  const pageEntries = entries.slice(safeStartIndex, safeStartIndex + pageSize);
  const hasMore = safeStartIndex + pageEntries.length < entries.length;
  const lastEntry = pageEntries[pageEntries.length - 1];
  return {
    chatList: Object.fromEntries(
      pageEntries.map((entry) => [entry.chatId, entry.settings]),
    ),
    hasMore,
    nextCursor: hasMore && lastEntry
      ? encodeCursor({
        pinned: lastEntry.pinned,
        sentTime: lastEntry.sentTime,
        chatId: lastEntry.chatId,
      })
      : null,
  };
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1_024) {
    throw new Error("cursor is invalid.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.pinned !== "boolean" ||
      !Number.isFinite(parsed.sentTime) ||
      typeof parsed.chatId !== "string" ||
      !parsed.chatId
    ) {
      throw new Error("invalid shape");
    }
    return parsed;
  } catch (_error) {
    throw new Error("cursor is invalid.");
  }
}

function decodeMessageCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1_024) {
    throw new Error("cursor is invalid.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Number.isFinite(parsed.sentTime) ||
      typeof parsed.messageId !== "string" ||
      !parsed.messageId
    ) {
      throw new Error("invalid shape");
    }
    return { sentTime: parsed.sentTime, id: parsed.messageId };
  } catch (_error) {
    throw new Error("cursor is invalid.");
  }
}

function elapsedMilliseconds(startedAt) {
  return (Number(process.hrtime.bigint() - startedAt) / 1_000_000).toFixed(2);
}

async function getUserProfileSummary(phoneNumber) {
  const normalizedPhoneNumber = normalizePhoneNumberForChatId(phoneNumber);
  const userDoc =
    (await getUserByPhoneNumber(normalizedPhoneNumber)) ||
    (await getUserByPhoneNumber(phoneNumber));
  if (!userDoc) {
    return null;
  }

  const profileData = userDoc && userDoc.profileData ? userDoc.profileData : {};
  return {
    phoneNumber:
      normalizePhoneNumberForChatId(profileData.phoneNumber) ||
      normalizedPhoneNumber,
    serverProfileName: profileData.name || profileData.displayName || "",
    profilePhotoUrl: profileData.profilePhotoUrl || null,
    isOnline: userDoc.isOnline || false,
    lastSeen: userDoc.lastSeen || Date.now(),
  };
}

function validatePhoneNumber({ phoneNumber }) {
  if (!phoneNumber) {
    return "phoneNumber is required.";
  }

  if (!/^[0-9]{7,15}$/.test(phoneNumber)) {
    return "phoneNumber must contain 7 to 15 digits.";
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

function validateDiscoverContacts({ contacts }) {
  if (!Array.isArray(contacts)) {
    return "contacts must be an array.";
  }
  if (contacts.length === 0) {
    return "contacts must not be empty.";
  }
  return null;
}

function validateChatSetting({ phoneNumber, chatId, setting, value }) {
  if (!chatId) return "chatId is required.";
  if (!chatId.split("_").map(normalizePhoneNumberForChatId).includes(phoneNumber)) {
    return "phoneNumber must be a participant in chatId.";
  }
  if (!["pin", "archive", "mute", "delete"].includes(setting)) {
    return "setting must be pin, archive, mute, or delete.";
  }
  if (!Number.isFinite(value)) return "value must be a number.";
  if ((setting === "pin" || setting === "archive") && value !== 0 && value !== 1) {
    return "pin and archive values must be 0 or 1.";
  }
  if (setting === "mute" && value !== -1 && value !== 0 && value <= Date.now()) {
    return "mute value must be 0, -1, or a future timestamp.";
  }
  return null;
}

function validateChatParticipant(phoneNumber, chatId) {
  if (!chatId) return "chatId is required.";
  if (!chatId.split("_").map(normalizePhoneNumberForChatId).includes(phoneNumber)) {
    return "phoneNumber must be a participant in chatId.";
  }
  return null;
}

function isStoredMessage(value) {
  return value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "text") &&
    Number.isFinite(Number(value.sentTime));
}

function invisibleNumbers(values) {
  return Array.isArray(values)
    ? values.map(normalizePhoneNumberForChatId).filter(Boolean) : [];
}

function includesInvisibleNumber(values, userId) {
  return invisibleNumbers(values).includes(normalizePhoneNumberForChatId(userId));
}

function addInvisibleNumber(values, userId) {
  return [...new Set([...invisibleNumbers(values), normalizePhoneNumberForChatId(userId)])]
    .filter(Boolean);
}

function pushChatSetting(phoneNumber, chatId, setting, value) {
  const socket = getUserSocket(phoneNumber);
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({
    type: "chat_settings_updated",
    chatId,
    setting,
    value,
    updatedAt: Date.now(),
  }));
}

function pushBlockStatus(phoneNumber, chatId, opponentId, blocked, updatedAt) {
  const socket = getUserSocket(phoneNumber);
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type: "chat_block_status", chatId, opponentId,
    blocked, updatedAt }));
}

function pushNewMessage(userId, message) {
  const socket = getUserSocket(userId);
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type: "new_message", message: forStorage(message) }));
}

function pushChatCleared(phoneNumber, chatId) {
  const socket = getUserSocket(phoneNumber);
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type: "chat_cleared", chatId, clearedAt: Date.now() }));
}

async function clearChatListPreview(userId, chatId) {
  const accountId = formatPhoneNumberForAccountId(userId);
  const existingDoc = await getChatsListByPhoneNumber(accountId);
  if (!existingDoc) return;
  const existingList = existingDoc.list;
  const list = Array.isArray(existingList)
    ? Object.fromEntries(existingList.map((id) => [id, defaultChatSettings()]))
    : existingList && typeof existingList === "object" ? existingList : {};
  if (!Object.prototype.hasOwnProperty.call(list, chatId)) return;
  const previousLastMessage = list[chatId] && list[chatId].last_message;
  const settings = {
    ...defaultChatSettings(),
    ...(list[chatId] || {}),
    last_message: previousLastMessage && typeof previousLastMessage === "object"
      ? {
        ...previousLastMessage,
        id: "",
        text: "",
        messageType: 0,
        cleared: true,
        attachment: null,
        attachmentName: null,
      }
      : null,
    unread_count: 0,
  };
  await firestoreManager.updateDocument("ChatsList", accountId, "/", {
    ...withoutDocumentId(existingDoc),
    list: { ...list, [chatId]: settings },
  });
}

async function updateReportLastMessage(userId, chatId, message) {
  const accountId = formatPhoneNumberForAccountId(userId);
  const existingDoc = await getChatsListByPhoneNumber(accountId);
  if (!existingDoc) return;
  const existingList = existingDoc.list;
  const list = Array.isArray(existingList)
    ? Object.fromEntries(existingList.map((id) => [id, defaultChatSettings()]))
    : existingList && typeof existingList === "object" ? existingList : {};
  const settings = { ...defaultChatSettings(), ...(list[chatId] || {}) };
  settings.last_message = forStorage(message);
  await firestoreManager.updateDocument("ChatsList", accountId, "/", {
    ...withoutDocumentId(existingDoc),
    list: { ...list, [chatId]: settings },
  });
}

function validateBulkChatSetting({ phoneNumber, chatIds, setting, value }) {
  if (!Array.isArray(chatIds) || chatIds.length === 0) {
    return "chatIds must be a non-empty array.";
  }
  for (const chatId of chatIds) {
    const validationError = validateChatSetting({
      phoneNumber,
      chatId,
      setting,
      value,
    });
    if (validationError) return validationError;
  }
  return null;
}

function defaultChatSettings() {
  return {
    pinned: false,
    notification_muted: 0,
    archieved: false,
    unread_count: 0,
  };
}

function withoutDocumentId(document) {
  const copy = { ...(document || {}) };
  delete copy._id;
  return copy;
}

module.exports = router;
