"use strict";

require("dotenv").config();

const FirestoreManager = require("../Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();

function defaultChatSettings() {
  return {
    pinned: false,
    notification_muted: "0",
    archieved: false,
    unread_count: 0,
    last_message: null,
  };
}

function chatIdFromListItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.chatId || item.id || item._id || "";
}

function convertListToMap(list) {
  if (Array.isArray(list)) {
    return Object.fromEntries(
      list
        .map(chatIdFromListItem)
        .filter(Boolean)
        .map((chatId) => [chatId, defaultChatSettings()]),
    );
  }

  if (list && typeof list === "object") {
    // Preserve existing preferences while supplying any missing defaults.
    return Object.fromEntries(
      Object.entries(list).map(([chatId, settings]) => [
        chatId,
        {
          ...defaultChatSettings(),
          ...(settings && typeof settings === "object" ? settings : {}),
        },
      ]),
    );
  }

  return {};
}

function getLatestMessage(chatDocument) {
  return Object.values(chatDocument || {})
    .filter(
      (value) =>
        value &&
        typeof value === "object" &&
        value.id &&
        Number.isFinite(Number(value.sentTime)),
    )
    .reduce(
      (latest, message) =>
        !latest || Number(message.sentTime) > Number(latest.sentTime)
          ? message
          : latest,
      null,
    );
}

async function startExecution() {
  const accountIds = await firestoreManager.readCollectionDocumentIds(
    "ChatsList",
    "/",
  );
  const summary = { total: accountIds.length, migrated: 0, normalized: 0 };

  console.log(`Migrating ${accountIds.length} ChatsList document(s)...`);
  for (let index = 0; index < accountIds.length; index += 1) {
    const accountId = accountIds[index];
    const document = await firestoreManager.readDocument(
      "ChatsList",
      accountId,
      "/",
    );
    const wasArray = Array.isArray(document && document.list);
    const updatedDocument = { ...document, list: convertListToMap(document && document.list) };
    for (const [chatId, settings] of Object.entries(updatedDocument.list)) {
      try {
        const chatDocument = await firestoreManager.readDocument("Chats", chatId, "/");
        updatedDocument.list[chatId] = {
          ...settings,
          last_message: getLatestMessage(chatDocument),
        };
      } catch (_error) {
        updatedDocument.list[chatId] = { ...settings, last_message: null };
      }
    }
    delete updatedDocument._id;

    await firestoreManager.updateDocument(
      "ChatsList",
      accountId,
      "/",
      updatedDocument,
    );

    if (wasArray) summary.migrated += 1;
    else summary.normalized += 1;
    console.log(
      `[${index + 1}/${accountIds.length}] ${accountId}` +
        ` -> ${Object.keys(updatedDocument.list).length} chat(s)`,
    );
  }

  console.log("ChatsList migration completed:", summary);
  return summary;
}

module.exports = {
  convertListToMap,
  defaultChatSettings,
  getLatestMessage,
  startExecution,
};

if (require.main === module) {
  startExecution().catch((error) => {
    console.error("ChatsList migration failed:", error.message);
    process.exitCode = 1;
  });
}
