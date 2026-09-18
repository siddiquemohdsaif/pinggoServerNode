"use strict";
require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const FirestoreManager = require("../Firestore/FirestoreManager");
const { chatEntries } = require("../utils/chatMembership");
const UserModel = require("../models/UserModel");
const { readShardedMap, upsertShardedEntries } = require("../models/ShardedDocumentStore");
const { MESSAGE_TYPE_CODES, forStorage } = require("../utils/messageTypes");
const { ensureAccountCollections } = require("../models/AccountStore");
const { saveCallLog } = require("../models/CallLogStore");
const { updateAttachment } = require("../models/ChatAttachmentStore");
const AES = require("../utils/AES_256");

const firestoreManager = FirestoreManager.getInstance();
const TARGET_PHONE_NUMBER = "919867180719";
const DEMO_ASSET_DIRECTORY = process.env.DEMO_ASSET_DIRECTORY || "D:\\Temp";
const MINIMUM_CHAT_COUNT = 1;
const MAXIMUM_CHAT_COUNT = 100;
const DEFAULT_CHAT_COUNT = 1;
const MINIMUM_MESSAGE_COUNT = 1;
const MAXIMUM_MESSAGE_COUNT = 10_000;
const DEFAULT_MEDIA_COUNT = 60;
const DEFAULT_DOCUMENT_COUNT = 40;
const DEFAULT_MIN_MESSAGE_COUNT = DEFAULT_MEDIA_COUNT + DEFAULT_DOCUMENT_COUNT;
const DEFAULT_MAX_MESSAGE_COUNT = 100;
const DEMO_GENERATOR = "test/test1.js";
const MESSAGE_TYPES = Object.freeze(Object.keys(MESSAGE_TYPE_CODES));
const FIRST_NAMES = [
  "Aarav",
  "Aditi",
  "Amelia",
  "Carlos",
  "Chen",
  "Daniel",
  "Elena",
  "Fatima",
  "Hana",
  "James",
  "Lucas",
  "Mateo",
  "Meera",
  "Noah",
  "Olivia",
  "Sofia",
  "Yuki",
];
const LAST_NAMES = [
  "Anderson",
  "Costa",
  "Dubois",
  "Garcia",
  "Gupta",
  "Hassan",
  "Ivanov",
  "Kim",
  "Martin",
  "Miller",
  "Nakamura",
  "Patel",
  "Rossi",
  "Silva",
  "Singh",
  "Wang",
];

// Phone numbers are stored in the same digits-only E.164 form used by Pinggo.
// Each template has a real country calling code and a plausible mobile prefix.
const COUNTRY_PHONE_FORMATS = Object.freeze([
  {
    countryName: "Argentina",
    countryIsoCode: "AR",
    countryCallingCode: "54",
    template: "54911########",
  },
  {
    countryName: "Australia",
    countryIsoCode: "AU",
    countryCallingCode: "61",
    template: "614########",
  },
  {
    countryName: "Bangladesh",
    countryIsoCode: "BD",
    countryCallingCode: "880",
    template: "8801#########",
  },
  {
    countryName: "Brazil",
    countryIsoCode: "BR",
    countryCallingCode: "55",
    template: "55119########",
  },
  {
    countryName: "Canada",
    countryIsoCode: "CA",
    countryCallingCode: "1",
    template: "1416#######",
  },
  {
    countryName: "China",
    countryIsoCode: "CN",
    countryCallingCode: "86",
    template: "8613#########",
  },
  {
    countryName: "Egypt",
    countryIsoCode: "EG",
    countryCallingCode: "20",
    template: "2010########",
  },
  {
    countryName: "France",
    countryIsoCode: "FR",
    countryCallingCode: "33",
    template: "336########",
  },
  {
    countryName: "Germany",
    countryIsoCode: "DE",
    countryCallingCode: "49",
    template: "4915#########",
  },
  {
    countryName: "India",
    countryIsoCode: "IN",
    countryCallingCode: "91",
    template: "919#########",
  },
  {
    countryName: "Indonesia",
    countryIsoCode: "ID",
    countryCallingCode: "62",
    template: "62812########",
  },
  {
    countryName: "Italy",
    countryIsoCode: "IT",
    countryCallingCode: "39",
    template: "3934########",
  },
  {
    countryName: "Japan",
    countryIsoCode: "JP",
    countryCallingCode: "81",
    template: "8190########",
  },
  {
    countryName: "Mexico",
    countryIsoCode: "MX",
    countryCallingCode: "52",
    template: "5255########",
  },
  {
    countryName: "Nigeria",
    countryIsoCode: "NG",
    countryCallingCode: "234",
    template: "23480########",
  },
  {
    countryName: "Pakistan",
    countryIsoCode: "PK",
    countryCallingCode: "92",
    template: "923#########",
  },
  {
    countryName: "Philippines",
    countryIsoCode: "PH",
    countryCallingCode: "63",
    template: "639#########",
  },
  {
    countryName: "Russia",
    countryIsoCode: "RU",
    countryCallingCode: "7",
    template: "79#########",
  },
  {
    countryName: "Saudi Arabia",
    countryIsoCode: "SA",
    countryCallingCode: "966",
    template: "9665########",
  },
  {
    countryName: "South Africa",
    countryIsoCode: "ZA",
    countryCallingCode: "27",
    template: "277########",
  },
  {
    countryName: "South Korea",
    countryIsoCode: "KR",
    countryCallingCode: "82",
    template: "8210########",
  },
  {
    countryName: "Spain",
    countryIsoCode: "ES",
    countryCallingCode: "34",
    template: "346########",
  },
  {
    countryName: "Turkey",
    countryIsoCode: "TR",
    countryCallingCode: "90",
    template: "905#########",
  },
  {
    countryName: "United Arab Emirates",
    countryIsoCode: "AE",
    countryCallingCode: "971",
    template: "9715########",
  },
  {
    countryName: "United Kingdom",
    countryIsoCode: "GB",
    countryCallingCode: "44",
    template: "447#########",
  },
  {
    countryName: "United States",
    countryIsoCode: "US",
    countryCallingCode: "1",
    template: "1202#######",
  },
]);

function randomItem(items) {
  return items[crypto.randomInt(items.length)];
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
  while (result.length < count) result.push(...shuffle(items));
  return result.slice(0, count);
}
function validateMessageCount(value) {
  const count = Number(value);
  if (
    !Number.isInteger(count) ||
    count < MINIMUM_MESSAGE_COUNT ||
    count > MAXIMUM_MESSAGE_COUNT
  ) {
    throw new RangeError(
      `Message count must be an integer from ${MINIMUM_MESSAGE_COUNT} through ${MAXIMUM_MESSAGE_COUNT}.`,
    );
  }
  return count;
}
function validateChatCount(value) {
  const count = Number(value);
  if (
    !Number.isInteger(count) ||
    count < MINIMUM_CHAT_COUNT ||
    count > MAXIMUM_CHAT_COUNT
  ) {
    throw new RangeError(
      `Chat count must be an integer from ${MINIMUM_CHAT_COUNT} through ${MAXIMUM_CHAT_COUNT}.`,
    );
  }
  return count;
}
function validateContentCount(value, label) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > MAXIMUM_MESSAGE_COUNT)
    throw new RangeError(`${label} count must be an integer from 0 through ${MAXIMUM_MESSAGE_COUNT}.`);
  return count;
}
function readContentCount(args, names, fallback, label) {
  const index = args.findIndex((value) => names.includes(value));
  return validateContentCount(index < 0 ? fallback : args[index + 1], label);
}
function readMediaCount(args = process.argv.slice(2)) {
  return readContentCount(args, ["--media"], DEFAULT_MEDIA_COUNT, "Media");
}
function readDocumentCount(args = process.argv.slice(2)) {
  return readContentCount(args, ["--documents", "--docs"], DEFAULT_DOCUMENT_COUNT,
    "Document");
}
function readChatCount(args = process.argv.slice(2)) {
  const index = args.findIndex(
    (value) => value === "--chats" || value === "-c",
  );
  return validateChatCount(index < 0 ? DEFAULT_CHAT_COUNT : args[index + 1]);
}
function readMessageCount(args = process.argv.slice(2)) {
  const index = args.findIndex(
    (value) => value === "--messages" || value === "-m",
  );
  return index < 0 ? null : validateMessageCount(args[index + 1]);
}
function readMessageRange(args = process.argv.slice(2)) {
  const exact = readMessageCount(args);
  if (exact !== null) return { minimum: exact, maximum: exact };
  const minimumIndex = args.findIndex((value) => value === "--min-messages");
  const maximumIndex = args.findIndex((value) => value === "--max-messages");
  const minimum = validateMessageCount(
    minimumIndex < 0 ? DEFAULT_MIN_MESSAGE_COUNT : args[minimumIndex + 1],
  );
  const maximum = validateMessageCount(
    maximumIndex < 0 ? DEFAULT_MAX_MESSAGE_COUNT : args[maximumIndex + 1],
  );
  if (minimum > maximum) {
    throw new RangeError(
      "Minimum message count cannot exceed maximum message count.",
    );
  }
  return { minimum, maximum };
}
function randomMessageCount({ minimum, maximum }) {
  return minimum === maximum ? minimum : crypto.randomInt(minimum, maximum + 1);
}
function buildMessageTypeSequence(messageCount, mediaCount, documentCount) {
  if (mediaCount + documentCount > messageCount)
    throw new RangeError("Media and document counts cannot exceed the message count.");
  const media = buildRandomizedSequence(["image", "video"], mediaCount);
  const documents = Array.from({ length: documentCount }, () => "file");
  const ordinaryTypes = MESSAGE_TYPES.filter(type => !["image", "video", "file"].includes(type));
  return shuffle([...media, ...documents,
    ...buildRandomizedSequence(ordinaryTypes, messageCount - mediaCount - documentCount)]);
}
function apiBaseUrl() {
  const configured =
    process.env.TEST_API_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return String(configured).replace(/\/$/, "");
  const port = process.env.PRODUCTION_TYPE === "release" ? 4100 : 4200;
  return `http://127.0.0.1:${port}`;
}
function bearer(account) {
  return `Bearer ${account.phoneNumber}_${account.credential}`;
}
async function responseJson(response, operation) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error(
      `${operation} returned invalid JSON (HTTP ${response.status}).`,
    );
  }
  if (!response.ok || payload.success === false) {
    throw new Error(
      `${operation} failed (HTTP ${response.status}): ${payload.message || text || "Unknown error"}`,
    );
  }
  return payload;
}
async function verifyDownload(url, expectedBuffer, label) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `${label} could not be fetched (HTTP ${response.status}): ${url}`,
    );
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (!downloaded.length)
    throw new Error(`${label} fetched an empty file: ${url}`);
  if (expectedBuffer && !downloaded.equals(expectedBuffer)) {
    throw new Error(
      `${label} fetched data does not match the uploaded file: ${url}`,
    );
  }
  return downloaded;
}
function assetMimeType(asset, kind) {
  const extension = path.extname(asset).toLowerCase();
  const types = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
  };
  if (types[extension]) return types[extension];
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mp4";
  return "video/mp4";
}
async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name));
}
async function prepareDemoAssets() {
  const [profiles, images, videos, audio] = await Promise.all([
    listFiles(path.join(DEMO_ASSET_DIRECTORY, "profile")),
    listFiles(path.join(DEMO_ASSET_DIRECTORY, "image")),
    listFiles(path.join(DEMO_ASSET_DIRECTORY, "video")),
    listFiles(path.join(DEMO_ASSET_DIRECTORY, "audio")),
  ]);
  if (!profiles.length || !images.length || !videos.length || !audio.length)
    throw new Error(
      `${DEMO_ASSET_DIRECTORY} must contain profile, image, video, and audio files.`,
    );
  // Message attachments are uploaded later, after the one chat id is known, so
  // their paths match the production chat-attachment layout.
  return { profiles, images, videos, audio };
}
function randomUppercase(length) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from(
    { length },
    () => letters[crypto.randomInt(letters.length)],
  ).join("");
}
function createInternationalPhoneNumber() {
  const country = randomItem(COUNTRY_PHONE_FORMATS);
  const phoneNumber = country.template.replace(/#/g, () =>
    String(crypto.randomInt(10)),
  );
  return { ...country, phoneNumber };
}
async function createUniqueAccount(profilePhotoUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const phone = createInternationalPhoneNumber();
    const { phoneNumber } = phone;
    if (phoneNumber === TARGET_PHONE_NUMBER) continue;
    let exists = false;
    try {
      exists = Boolean(
        await firestoreManager.readDocument("Users", phoneNumber, "/"),
      );
    } catch (_error) {
      /* missing */
    }
    if (exists) continue;
    const name = `${randomItem(FIRST_NAMES)} ${randomItem(LAST_NAMES)}`;
    const personalId = randomUppercase(9);
    const profileData = {
      name,
      phoneNumber,
      P_ID: personalId,
      profilePhotoUrl,
      countryName: phone.countryName,
      countryIsoCode: phone.countryIsoCode,
      countryCallingCode: phone.countryCallingCode,
      demoGeneratedBy: DEMO_GENERATOR,
    };
    const user = new UserModel(
      phoneNumber,
      profileData,
      AES.getEncryptedCredential(phoneNumber, personalId),
    );
    await firestoreManager.createDocument("P-ID-MAP", personalId, "/", {
      phoneNumber,
    });
    await firestoreManager.createDocument("Users", phoneNumber, "/", {
      ...user,
    });
    await ensureAccountCollections(phoneNumber);
    return {
      phoneNumber,
      name,
      personalId,
      countryName: phone.countryName,
      countryIsoCode: phone.countryIsoCode,
      credential: user.encryptedCredential,
    };
  }
  throw new Error("Could not create a unique demo account.");
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
async function addChatToList(phoneNumber, chatId, lastMessage) {
  let current = null;
  try {
    current = await firestoreManager.readDocument(
      "ChatsList",
      phoneNumber,
      "/",
    );
  } catch (_error) {
    /* missing */
  }
  const list = chatEntries(current);
  const data = {
    [chatId]: { ...defaultChatSettings(), ...(list[chatId] || {}), last_message: lastMessage },
  };
  if (current)
    await firestoreManager.updateDocument("ChatsList", phoneNumber, "/", data);
  else
    await firestoreManager.createDocument("ChatsList", phoneNumber, "/", data);
}
function baseMessage({
  chatId,
  senderId,
  receiverId,
  messageType,
  sentTime,
  sequence,
}) {
  return {
    // Production messages use their millisecond timestamp as both the Firestore
    // entry key and message id. The generated timestamps below are already unique.
    id: String(sentTime),
    clientMessageId: `demo-${crypto.randomUUID()}`,
    chatId,
    senderId,
    receiverId,
    text: "",
    messageType,
    sentTime,
    deliveredTime: sentTime + 250,
    readTime: sentTime + 500,
    status: "seen",
    invisible: [],
  };
}
async function uploadProfilePhoto(account, asset) {
  const source = await fs.readFile(asset);
  const response = await fetch(`${apiBaseUrl()}/profile/uploadProfilePhoto`, {
    method: "POST",
    headers: {
      Authorization: bearer(account),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ profilePhotoBase64: source.toString("base64") }),
  });
  const payload = await responseJson(response, "Profile photo upload");
  await verifyDownload(payload.profilePhotoUrl, null, "Profile photo");
  return payload.profilePhotoUrl;
}
async function createAttachment({
  chatId,
  senderId,
  messageId,
  messageType,
  asset,
  sentTime,
  account,
}) {
  if (senderId !== account.phoneNumber)
    throw new Error("Demo attachment sender must own its API credential.");
  const inline = asset && typeof asset === "object" && Buffer.isBuffer(asset.buffer);
  const buffer = inline ? asset.buffer : await fs.readFile(asset);
  const fileName = inline ? asset.name : path.basename(asset);
  const uploadMimeType = inline ? asset.mimeType : assetMimeType(asset, messageType);
  const form = new FormData();
  form.append("chatId", chatId);
  form.append("kind", messageType);
  form.append(
    "file",
    new Blob([buffer], { type: uploadMimeType }),
    fileName,
  );
  const response = await fetch(`${apiBaseUrl()}/chats/attachments`, {
    method: "POST",
    headers: { Authorization: bearer(account) },
    body: form,
  });
  const payload = await responseJson(
    response,
    `${messageType} attachment upload`,
  );
  const attachment = payload.attachment;
  // MP4 video normalization changes container bytes without re-encoding media.
  // Every other attachment type must remain byte-identical.
  const downloaded = await verifyDownload(attachment.url,
    messageType === "video" && uploadMimeType === "video/mp4" ? null : buffer,
    `${messageType} attachment`);
  const downloadedHash = crypto.createHash("sha256").update(downloaded).digest("hex");
  if (attachment.sha256 && downloadedHash !== attachment.sha256) {
    throw new Error(`${messageType} attachment checksum does not match server metadata.`);
  }
  await updateAttachment(chatId, attachment.id, {
    status: "attached",
    messageId,
    attachedTime: sentTime,
    demo: true,
  });
  const { id, kind, name, mimeType, size, url, sha256, durationMs,
    width, height, orientation } = attachment;
  return { id, kind, name, mimeType, size, url, sha256,
    ...(durationMs ? { durationMs } : {}),
    ...(width && height ? { width, height, orientation } : {}) };
}
function demoDocumentAsset(sequence) {
  return {
    name: `pinggo-demo-document-${sequence + 1}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(
      `Pinggo demo document ${sequence + 1}\nGenerated by ${DEMO_GENERATOR}\n`,
      "utf8",
    ),
  };
}
async function createMessage({
  chatId,
  senderId,
  receiverId,
  messageType,
  sentTime,
  sequence,
  assets,
  account,
}) {
  const message = baseMessage({
    chatId,
    senderId,
    receiverId,
    messageType,
    sentTime,
    sequence,
  });
  if (messageType === "text")
    message.text = `Demo text message ${sequence + 1}`;
  if (["image", "video", "audio", "file"].includes(messageType)) {
    const asset = messageType === "file"
      ? demoDocumentAsset(sequence)
      : messageType === "image"
      ? assets.image
      : messageType === "audio"
        ? assets.audio
        : assets.video;
    message.text = `Demo ${messageType} attachment`;
    message.attachment = await createAttachment({
      chatId,
      senderId,
      messageId: message.id,
      messageType,
      asset,
      sentTime,
      account,
    });
  }
  if (messageType === "location") {
    message.text = "Demo location: New Delhi";
    message.location = { latitude: 28.6139, longitude: 77.209, accuracy: 10 };
  }
  if (messageType === "voice_call" || messageType === "video_call") {
    const durationSeconds = 5 + (sequence % 176);
    const participantIds = [senderId, receiverId];
    Object.assign(message, {
      clientMessageId: null,
      callId: crypto.randomUUID(),
      text: messageType === "video_call" ? "Video Call" : "Voice Call",
      callDurationSeconds: durationSeconds,
      callCreatedAt: sentTime - (durationSeconds + 3) * 1000,
      callRingingAt: sentTime - (durationSeconds + 2) * 1000,
      callConnectedAt: sentTime - durationSeconds * 1000,
      callEndedAt: sentTime,
      callTerminationReason: "hangup",
      callerText: "Outgoing call",
      receiverText: "Incoming call",
      conferenceCall: false,
      groupCall: false,
      callParticipantIds: participantIds,
      callParticipantDurationsSeconds: Object.fromEntries(
        participantIds.map((participantId) => [participantId, durationSeconds]),
      ),
    });
  }
  if (messageType === "report")
    Object.assign(message, {
      text: "Message reported for demo testing",
      reportReason: "demo_report",
      reportedMessageId: "demo-reported-message",
    });
  if (messageType === "chat_report")
    Object.assign(message, {
      text: "Chat reported for demo testing",
      reportReason: "demo_chat_report",
      reportedChatId: chatId,
    });
  if (messageType === "chat_block") message.text = "Chat blocked";
  if (messageType === "chat_unblock") message.text = "Chat unblocked";
  if (messageType === "group_system")
    Object.assign(message, {
      text: "Demo member joined the group",
      groupSystemAction: "member_joined",
      affectedUserId: senderId,
    });
  return message;
}
async function createDemoChat({ messageCount, mediaCount, documentCount, assets }) {
  const profileSource = randomItem(assets.profiles);
  const account = await createUniqueAccount(null);
  account.profilePhotoUrl = await uploadProfilePhoto(account, profileSource);
  const chatId = `${account.phoneNumber}_${TARGET_PHONE_NUMBER}`;
  const messageTypes = buildMessageTypeSequence(messageCount, mediaCount, documentCount);
  const now = Date.now();
  const messages = {};
  const callMessages = [];
  for (let index = 0; index < messageCount; index += 1) {
    const attachmentMessage = ["image", "video", "audio", "file"]
      .includes(messageTypes[index]);
    const outgoing = attachmentMessage || index % 2 === 0;
    const message = await createMessage({
      chatId,
      senderId: outgoing ? account.phoneNumber : TARGET_PHONE_NUMBER,
      receiverId: outgoing ? TARGET_PHONE_NUMBER : account.phoneNumber,
      messageType: messageTypes[index],
      sentTime: now - (messageCount - index) * 1000,
      sequence: index,
      assets: {
        image: randomItem(assets.images),
        video: randomItem(assets.videos),
        audio: randomItem(assets.audio),
      },
      account,
    });
    messages[message.id] = forStorage(message);
    if (message.callId) callMessages.push(message);
  }
  const writeResult = await upsertShardedEntries("Chats", chatId, messages);
  const expectedAttachmentIds = Object.values(messages)
    .map((message) => message.attachment && message.attachment.id)
    .filter(Boolean);
  const storedAttachments = await readShardedMap(
    "ChatAttachments", chatId, "attachments");
  for (const attachmentId of expectedAttachmentIds) {
    const stored = storedAttachments && storedAttachments[attachmentId];
    if (!stored || stored.chatId !== chatId || stored.status !== "attached") {
      throw new Error(
        `Attachment ${attachmentId} was not stored in the chat-scoped attachment batches.`,
      );
    }
  }
  const createdChatIds = new Set(
    Object.values(messages).map((message) => message.chatId),
  );
  if (createdChatIds.size !== 1 || !createdChatIds.has(chatId))
    throw new Error("Each demo account must create exactly one chat.");
  const latestMessage = Object.values(messages)
    .sort((a, b) => a.sentTime - b.sentTime)
    .at(-1);
  const latestForSender = {
    ...latestMessage,
    text: latestMessage.callerText || latestMessage.text,
  };
  const latestForReceiver = {
    ...latestMessage,
    text: latestMessage.receiverText || latestMessage.text,
  };
  await Promise.all([
    addChatToList(latestMessage.senderId, chatId, latestForSender),
    addChatToList(latestMessage.receiverId, chatId, latestForReceiver),
    ...callMessages.map((message) =>
      saveCallLog({
        callId: message.callId,
        messageId: message.id,
        chatId: message.chatId,
        callerId: message.senderId,
        receiverId: message.receiverId,
        mediaType: message.messageType === "video_call" ? "video" : "audio",
        state: "ended",
        terminationReason: message.callTerminationReason,
        createdAt: message.callCreatedAt,
        ringingAt: message.callRingingAt,
        connectedAt: message.callConnectedAt,
        endedAt: message.callEndedAt,
        participantIds: message.callParticipantIds,
        historyParticipantIds: message.callParticipantIds,
        participantJoinedAt: Object.fromEntries(
          message.callParticipantIds.map((participantId) => [
            participantId,
            message.callConnectedAt,
          ]),
        ),
        participantLeftAt: Object.fromEntries(
          message.callParticipantIds.map((participantId) => [
            participantId,
            message.callEndedAt,
          ]),
        ),
        conference: false,
      }),
    ),
  ]);
  const includedTypes = [...new Set(messageTypes)];
  console.log(
    `Created chat ${chatId} with ${messageCount} messages, real attachment files, and ${callMessages.length} per-user call logs.`,
  );
  const { credential: _credential, ...publicAccount } = account;
  return {
    account: publicAccount,
    chatId,
    messageCount,
    messageTypes: includedTypes,
    mediaCount,
    documentCount,
    callLogCount: callMessages.length,
    writeResult,
  };
}

async function startExecution(options = {}) {
  const chatCount = validateChatCount(options.chatCount ?? readChatCount());
  const mediaCount = validateContentCount(options.mediaCount ?? readMediaCount(), "Media");
  const documentCount = validateContentCount(
    options.documentCount ?? readDocumentCount(), "Document");
  const range =
    options.messageCount != null
      ? {
          minimum: validateMessageCount(options.messageCount),
          maximum: validateMessageCount(options.messageCount),
        }
      : options.minMessageCount != null || options.maxMessageCount != null
        ? readMessageRange([
            "--min-messages",
            String(options.minMessageCount ?? DEFAULT_MIN_MESSAGE_COUNT),
            "--max-messages",
            String(options.maxMessageCount ?? DEFAULT_MAX_MESSAGE_COUNT),
          ])
        : readMessageRange();
  if (range.minimum < mediaCount + documentCount)
    throw new RangeError(
      `Minimum message count must be at least ${mediaCount + documentCount} `
      + `for ${mediaCount} media and ${documentCount} document messages.`,
    );
  const assets = await prepareDemoAssets();
  const chats = [];
  for (let index = 0; index < chatCount; index += 1) {
    const messageCount = randomMessageCount(range);
    if (messageCount < MESSAGE_TYPES.length)
      console.warn(
        `Coverage warning: chat ${index + 1} has ${messageCount} messages and cannot contain all ${MESSAGE_TYPES.length} types.`,
      );
    chats.push(await createDemoChat({ messageCount, mediaCount, documentCount, assets }));
  }
  console.log(
    `Created ${chats.length} chat(s) with message counts in the requested ${range.minimum}-${range.maximum} range, ${mediaCount} media, and ${documentCount} documents per chat.`,
  );
  return {
    chatCount: chats.length,
    messageCountRange: range,
    mediaCount,
    documentCount,
    chats,
    // Preserve the original result fields for callers that create the default one chat.
    ...(chats.length === 1 ? chats[0] : {}),
  };
}

module.exports = {
  COUNTRY_PHONE_FORMATS,
  MESSAGE_TYPES,
  MINIMUM_CHAT_COUNT,
  DEFAULT_MEDIA_COUNT,
  DEFAULT_DOCUMENT_COUNT,
  buildRandomizedSequence,
  buildMessageTypeSequence,
  demoDocumentAsset,
  createInternationalPhoneNumber,
  createMessage,
  randomMessageCount,
  readChatCount,
  readMessageCount,
  readMessageRange,
  readMediaCount,
  readDocumentCount,
  startExecution,
};
if (require.main === module)
  startExecution().catch((error) => {
    console.error("Demo execution failed:", error);
    process.exitCode = 1;
  });
