const express = require("express");
const FirestoreManager = require("../Firestore/FirestoreManager");
const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();

router.post("/list", async (req, res) => {
  const routeStartedAt = process.hrtime.bigint();
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const pageSize = normalizePageSize(req.body.pageSize);
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
      const userProfiles = await getOtherUserProfilesFromChatList(
        page.chatList,
        phoneNumber,
      );

      return res.status(200).json({
        success: true,
        userProfiles,
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

    return res.status(200).json({ success: true, chatId, settings });
  } catch (error) {
    console.error("Error updating chat settings:", error.message);
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
      messages,
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
  const chatIds = getChatIdsFromChatList(chatList);
  const chatContacts = chatIds.map((chatId) => ({
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

  return chatContacts.map(({ chatId, phoneNumber: contactPhoneNumber }) => {
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
