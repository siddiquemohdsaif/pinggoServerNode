"use strict";

require("dotenv").config();

const crypto = require("crypto");
const FirestoreManager = require("../Firestore/FirestoreManager");
const UserModel = require("../models/UserModel");
const AES = require("../utils/AES_256");

const firestoreManager = FirestoreManager.getInstance();
const TARGET_PHONE_NUMBER = "919867400865";
const ACCOUNT_COUNT = 100;
const MESSAGE_TYPES = ["text", "voice_call", "video_call", "image", "video"];
const PAST_TIME_OFFSETS_MS = [
  5 * 60 * 1_000,          // 5 minutes ago
  15 * 60 * 1_000,         // 15 minutes ago
  30 * 60 * 1_000,         // 30 minutes ago
  2 * 60 * 60 * 1_000,     // 2 hours ago
  6 * 60 * 60 * 1_000,     // 6 hours ago
  24 * 60 * 60 * 1_000,    // 1 day ago
  2 * 24 * 60 * 60 * 1_000,// 2 days ago
  3 * 24 * 60 * 60 * 1_000,// 3 days ago
  7 * 24 * 60 * 60 * 1_000,// 1 week ago
  14 * 24 * 60 * 60 * 1_000,// 2 weeks ago
  365 * 24 * 60 * 60 * 1_000,// 1 year ago
];

const FIRST_NAMES = [
  "Aarav", "Aditi", "Advait", "Ananya", "Arjun", "Diya", "Ishaan", "Kavya",
  "Meera", "Kripa", "Priya", "Rohan", "Saanvi", "Vihaan", "Vikram",
];
const LAST_NAMES = [
  "Gupta", "Iyer", "Joshi", "Kapoor", "Khan", "Mehta", "Nair", "Patel",
  "Rao", "Shah", "Sharma", "Singh", "Verma",
];

function randomItem(items) {
  return items[crypto.randomInt(items.length)];
}

function randomUppercase(length) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length }, () => letters[crypto.randomInt(letters.length)]).join("");
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function buildRandomizedSequence(items, count) {
  const result = [];
  while (result.length < count) {
    result.push(...shuffle(items));
  }
  return result.slice(0, count);
}

function formatCallDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pair = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${pair(hours)}:${pair(minutes)}:${pair(seconds)}`
    : `${pair(minutes)}:${pair(seconds)}`;
}

function createIndianPhoneNumber(existingNumbers) {
  // Indian mobile subscriber numbers begin with 6, 7, 8, or 9.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const subscriberNumber = `${randomItem(["6", "7", "8", "9"])}${crypto
      .randomInt(0, 1_000_000_000)
      .toString()
      .padStart(9, "0")}`;
    const phoneNumber = `91${subscriberNumber}`;
    if (phoneNumber !== TARGET_PHONE_NUMBER && !existingNumbers.has(phoneNumber)) {
      existingNumbers.add(phoneNumber);
      return phoneNumber;
    }
  }
  throw new Error("Could not generate a unique Indian phone number.");
}

async function documentExists(collection, documentId) {
  try {
    return Boolean(await firestoreManager.readDocument(collection, documentId, "/"));
  } catch (_error) {
    return false;
  }
}

async function createUniqueAccount(existingNumbers) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const phoneNumber = createIndianPhoneNumber(existingNumbers);
    if (await documentExists("Users", phoneNumber)) continue;

    const name = `${randomItem(FIRST_NAMES)} ${randomItem(LAST_NAMES)}`;
    const pId = randomUppercase(9);
    const profileData = { name, phoneNumber, P_ID: pId };
    const user = new UserModel(
      phoneNumber,
      profileData,
      AES.getEncryptedCredential(phoneNumber, pId),
    );

    await firestoreManager.createDocument("P-ID-MAP", pId, "/", { phoneNumber });
    await firestoreManager.createDocument("Users", phoneNumber, "/", { ...user });
    await firestoreManager.createDocument("ChatsList", phoneNumber, "/", { list: {} });
    return { phoneNumber, name, pId };
  }
  throw new Error("Could not create a unique demo account.");
}

async function addChatToList(phoneNumber, chatId, lastMessage) {
  let current = null;
  try {
    current = await firestoreManager.readDocument("ChatsList", phoneNumber, "/");
  } catch (_error) {
    // The target account may not have a ChatsList document yet.
  }

  const storedList = current && current.list;
  const list = Array.isArray(storedList)
    ? Object.fromEntries(storedList.map((id) => [id, defaultChatSettings()]))
    : storedList && typeof storedList === "object"
      ? storedList
      : {};
  const existingSettings = list[chatId] || {};
  const nextDocument = {
    list: {
      ...list,
      [chatId]: {
        ...defaultChatSettings(),
        ...existingSettings,
        last_message: lastMessage || existingSettings.last_message || null,
      },
    },
  };

  if (current) {
    await firestoreManager.updateDocument("ChatsList", phoneNumber, "/", nextDocument);
  } else {
    await firestoreManager.createDocument("ChatsList", phoneNumber, "/", nextDocument);
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

function createBaseMessage({ chatId, senderId, messageType, sentTime }) {
  return {
    id: String(sentTime),
    clientMessageId: `demo-${crypto.randomUUID()}`,
    chatId,
    senderId,
    receiverId: TARGET_PHONE_NUMBER,
    text: "",
    messageType,
    sentTime,
    deliveredTime: sentTime + 500,
    readTime: sentTime + 1_000,
    status: "seen",
  };
}

async function createEndingMessage({ chatId, senderId, messageType, index, sentTime }) {
  const message = createBaseMessage({ chatId, senderId, messageType, sentTime });

  if (messageType === "text") {
    message.text = randomItem([
      "Hi! This is a demo chat message.",
      "Hello, testing Pinggo chat from India.",
      "Demo conversation completed successfully.",
    ]);
  } else if (messageType === "voice_call" || messageType === "video_call") {
    const durationSeconds = crypto.randomInt(5, 181);
    const connectedAt = sentTime - durationSeconds * 1_000;
    message.clientMessageId = null;
    message.callId = crypto.randomUUID();
    const callLabel = messageType === "video_call" ? "Video Call" : "Voice Call";
    message.text = `[${callLabel}] ${formatCallDuration(durationSeconds)}`;
    message.callDurationSeconds = durationSeconds;
    message.callCreatedAt = connectedAt - 3_000;
    message.callRingingAt = connectedAt - 2_000;
    message.callConnectedAt = connectedAt;
    message.callEndedAt = sentTime;
    message.callTerminationReason = "hangup";
  } else {
    const isImage = messageType === "image";
    const attachmentId = crypto.randomUUID();
    const extension = isImage ? "jpg" : "mp4";
    const mimeType = isImage ? "image/jpeg" : "video/mp4";
    const name = `demo-${index + 1}.${extension}`;
    const relativeUrl = `/files/demo/${name}`;
    const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const attachment = {
      id: attachmentId,
      chatId,
      uploaderId: senderId,
      kind: messageType,
      name,
      mimeType,
      size: 0,
      fullPath: `demo/${name}`,
      url: publicBaseUrl ? `${publicBaseUrl}${relativeUrl}` : relativeUrl,
      status: "attached",
      createdTime: sentTime,
      completedTime: sentTime,
      messageId: message.id,
      attachedTime: sentTime,
      demo: true,
    };
    await firestoreManager.createDocument("ChatAttachments", attachmentId, "/", attachment);
    message.text = isImage ? "Demo image" : "Demo video";
    message.attachment = {
      id: attachmentId,
      kind: messageType,
      name,
      mimeType,
      size: 0,
      url: attachment.url,
    };
  }

  return message;
}

async function startExecution() {
  const usedNumbers = new Set([TARGET_PHONE_NUMBER]);
  // Repeat shuffled cycles so these arrays always match ACCOUNT_COUNT.
  const randomizedTypes = buildRandomizedSequence(MESSAGE_TYPES, ACCOUNT_COUNT);
  const randomizedTimeOffsets = buildRandomizedSequence(
    PAST_TIME_OFFSETS_MS,
    ACCOUNT_COUNT,
  );
  const executionTime = Date.now();
  const results = [];

  console.log(`Creating ${ACCOUNT_COUNT} demo Indian accounts...`);
  for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
    const account = await createUniqueAccount(usedNumbers);
    const chatId = `${account.phoneNumber}_${TARGET_PHONE_NUMBER}`;
    const messageType = randomizedTypes[index];
    const sentTime = executionTime - randomizedTimeOffsets[index];
    const message = await createEndingMessage({
      chatId,
      senderId: account.phoneNumber,
      messageType,
      index,
      sentTime,
    });

    await firestoreManager.createDocument("Chats", chatId, "/", {
      [message.id]: message,
    });
    await Promise.all([
      addChatToList(account.phoneNumber, chatId, message),
      addChatToList(TARGET_PHONE_NUMBER, chatId, message),
    ]);

    const result = {
      ...account,
      chatId,
      endingMessageType: messageType,
      sentTime,
      sentAt: new Date(sentTime).toISOString(),
    };
    results.push(result);
    console.log(
      `[${index + 1}/${ACCOUNT_COUNT}] ${account.phoneNumber} -> ${messageType}` +
        ` at ${result.sentAt}`,
    );
  }

  console.log("Demo execution completed.");
  return results;
}

module.exports = { buildRandomizedSequence, startExecution };

if (require.main === module) {
  startExecution().catch((error) => {
    console.error("Demo execution failed:", error.message);
    process.exitCode = 1;
  });
}
