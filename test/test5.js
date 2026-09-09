"use strict";

require("dotenv").config();

const crypto = require("crypto");
const FirestoreManager = require("../Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();
const CHAT_ID = "919867180719_919867400865";
const TARGET_MESSAGE_COUNT = 3000;

function isMessage(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isSafeInteger(Number(value.sentTime)) &&
      Number(value.sentTime) > 0,
  );
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function createRepeatedMessages(chatDocument, targetCount = TARGET_MESSAGE_COUNT) {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
    throw new Error("targetCount must be a positive safe integer.");
  }

  const existingMessages = Object.entries(chatDocument || {})
    .filter(([, value]) => isMessage(value))
    .sort((left, right) => Number(left[1].sentTime) - Number(right[1].sentTime));

  if (existingMessages.length === 0) {
    throw new Error(`Chat ${CHAT_ID} does not contain any messages to repeat.`);
  }
  if (existingMessages.length >= targetCount) return {};

  const additions = {};
  const usedIds = new Set(existingMessages.map(([fieldId]) => String(fieldId)));
  let nextSentTime = Math.max(
    Date.now(),
    ...existingMessages.map(([, message]) => Number(message.sentTime)),
  );

  for (let index = 0; existingMessages.length + index < targetCount; index += 1) {
    const source = existingMessages[index % existingMessages.length][1];
    const repeated = cloneMessage(source);

    do {
      nextSentTime += 1;
    } while (usedIds.has(String(nextSentTime)));

    const sourceSentTime = Number(source.sentTime);
    const deliveredDelay = Number(source.deliveredTime) - sourceSentTime;
    const readDelay = Number(source.readTime) - sourceSentTime;
    const id = String(nextSentTime);

    repeated.id = id;
    repeated.sentTime = nextSentTime;
    repeated.clientMessageId = source.clientMessageId === null
      ? null
      : `repeat-${crypto.randomUUID()}`;

    if (Number.isFinite(deliveredDelay)) {
      repeated.deliveredTime = nextSentTime + Math.max(0, deliveredDelay);
    }
    if (Number.isFinite(readDelay)) {
      repeated.readTime = nextSentTime + Math.max(0, readDelay);
    }

    // A repeated attachment must not claim ownership of the source attachment.
    delete repeated.attachment;
    delete repeated.repliedMessageId;

    additions[id] = repeated;
    usedIds.add(id);
  }

  return additions;
}

async function startExecution() {
  const chatDocument = await firestoreManager.readDocument("Chats", CHAT_ID, "/");
  const existingCount = Object.values(chatDocument || {}).filter(isMessage).length;
  const additions = createRepeatedMessages(chatDocument);
  const addedCount = Object.keys(additions).length;

  if (addedCount === 0) {
    console.log(
      `Chat ${CHAT_ID} already contains ${existingCount} messages; nothing was added.`,
    );
    return { chatId: CHAT_ID, existingCount, addedCount: 0, finalCount: existingCount };
  }

  await firestoreManager.updateDocument("Chats", CHAT_ID, "/", additions);

  const result = {
    chatId: CHAT_ID,
    existingCount,
    addedCount,
    finalCount: existingCount + addedCount,
  };
  console.log("Chat message repeat completed:", result);
  return result;
}

module.exports = { createRepeatedMessages, startExecution };

if (require.main === module) {
  startExecution().catch((error) => {
    console.error("Chat message repeat failed:", error.message);
    process.exitCode = 1;
  });
}
