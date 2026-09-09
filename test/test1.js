"use strict";
require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const FirestoreManager = require("../Firestore/FirestoreManager");
const UserModel = require("../models/UserModel");
const { upsertShardedEntries } = require("../models/ShardedDocumentStore");
const { MESSAGE_TYPE_CODES, forStorage } = require("../utils/messageTypes");
const { saveFile } = require("../utils/fileStorage");
const { ensureAccountCollections } = require("../models/AccountStore");
const AES = require("../utils/AES_256");

const firestoreManager = FirestoreManager.getInstance();
const TARGET_PHONE_NUMBER = "919867400865";
const DEMO_ASSET_DIRECTORY = process.env.DEMO_ASSET_DIRECTORY || "D:\\Temp";
const MINIMUM_MESSAGE_COUNT = 1;
const MAXIMUM_MESSAGE_COUNT = 10_000;
const DEFAULT_MESSAGE_COUNT = 100;
const MESSAGE_TYPES = Object.freeze(Object.keys(MESSAGE_TYPE_CODES));
const FIRST_NAMES = ["Aarav", "Aditi", "Amelia", "Carlos", "Chen", "Daniel", "Elena", "Fatima", "Hana", "James", "Lucas", "Mateo", "Meera", "Noah", "Olivia", "Sofia", "Yuki"];
const LAST_NAMES = ["Anderson", "Costa", "Dubois", "Garcia", "Gupta", "Hassan", "Ivanov", "Kim", "Martin", "Miller", "Nakamura", "Patel", "Rossi", "Silva", "Singh", "Wang"];

// Phone numbers are stored in the same digits-only E.164 form used by Pinggo.
// Each template has a real country calling code and a plausible mobile prefix.
const COUNTRY_PHONE_FORMATS = Object.freeze([
  { countryName: "Argentina", countryIsoCode: "AR", countryCallingCode: "54", template: "54911########" },
  { countryName: "Australia", countryIsoCode: "AU", countryCallingCode: "61", template: "614########" },
  { countryName: "Bangladesh", countryIsoCode: "BD", countryCallingCode: "880", template: "8801#########" },
  { countryName: "Brazil", countryIsoCode: "BR", countryCallingCode: "55", template: "55119########" },
  { countryName: "Canada", countryIsoCode: "CA", countryCallingCode: "1", template: "1416#######" },
  { countryName: "China", countryIsoCode: "CN", countryCallingCode: "86", template: "8613#########" },
  { countryName: "Egypt", countryIsoCode: "EG", countryCallingCode: "20", template: "2010########" },
  { countryName: "France", countryIsoCode: "FR", countryCallingCode: "33", template: "336########" },
  { countryName: "Germany", countryIsoCode: "DE", countryCallingCode: "49", template: "4915#########" },
  { countryName: "India", countryIsoCode: "IN", countryCallingCode: "91", template: "919#########" },
  { countryName: "Indonesia", countryIsoCode: "ID", countryCallingCode: "62", template: "62812########" },
  { countryName: "Italy", countryIsoCode: "IT", countryCallingCode: "39", template: "3934########" },
  { countryName: "Japan", countryIsoCode: "JP", countryCallingCode: "81", template: "8190########" },
  { countryName: "Mexico", countryIsoCode: "MX", countryCallingCode: "52", template: "5255########" },
  { countryName: "Nigeria", countryIsoCode: "NG", countryCallingCode: "234", template: "23480########" },
  { countryName: "Pakistan", countryIsoCode: "PK", countryCallingCode: "92", template: "923#########" },
  { countryName: "Philippines", countryIsoCode: "PH", countryCallingCode: "63", template: "639#########" },
  { countryName: "Russia", countryIsoCode: "RU", countryCallingCode: "7", template: "79#########" },
  { countryName: "Saudi Arabia", countryIsoCode: "SA", countryCallingCode: "966", template: "9665########" },
  { countryName: "South Africa", countryIsoCode: "ZA", countryCallingCode: "27", template: "277########" },
  { countryName: "South Korea", countryIsoCode: "KR", countryCallingCode: "82", template: "8210########" },
  { countryName: "Spain", countryIsoCode: "ES", countryCallingCode: "34", template: "346########" },
  { countryName: "Turkey", countryIsoCode: "TR", countryCallingCode: "90", template: "905#########" },
  { countryName: "United Arab Emirates", countryIsoCode: "AE", countryCallingCode: "971", template: "9715########" },
  { countryName: "United Kingdom", countryIsoCode: "GB", countryCallingCode: "44", template: "447#########" },
  { countryName: "United States", countryIsoCode: "US", countryCallingCode: "1", template: "1202#######" },
]);

function randomItem(items) { return items[crypto.randomInt(items.length)]; }
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
  if (!Number.isInteger(count) || count < MINIMUM_MESSAGE_COUNT || count > MAXIMUM_MESSAGE_COUNT) {
    throw new RangeError(`Message count must be an integer from ${MINIMUM_MESSAGE_COUNT} through ${MAXIMUM_MESSAGE_COUNT}.`);
  }
  return count;
}
function readMessageCount(args = process.argv.slice(2)) {
  const index = args.findIndex((value) => value === "--messages" || value === "-m");
  return validateMessageCount(index < 0 ? DEFAULT_MESSAGE_COUNT : args[index + 1]);
}
function publicUrl(publicPath) {
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return base ? `${base}${publicPath}` : publicPath;
}
async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name));
}
async function copyAsset(sourcePath, requestedPath, mimeType) {
  const saved = await saveFile({ buffer: await fs.readFile(sourcePath), requestedPath, originalName: path.basename(sourcePath), mimeType });
  return { ...saved, url: publicUrl(saved.publicPath), sha256: crypto.createHash("sha256").update(await fs.readFile(sourcePath)).digest("hex") };
}
async function prepareDemoAssets() {
  const [profiles, images, videos] = await Promise.all([
    listFiles(path.join(DEMO_ASSET_DIRECTORY, "profile")),
    listFiles(path.join(DEMO_ASSET_DIRECTORY, "image")),
    listFiles(path.join(DEMO_ASSET_DIRECTORY, "video")),
  ]);
  if (!profiles.length || !images.length || !videos.length) throw new Error(`${DEMO_ASSET_DIRECTORY} must contain profile, image, and video files.`);
  const profileSource = randomItem(profiles);
  const [profile, image, video] = await Promise.all([
    copyAsset(profileSource, "profile_photo/", path.extname(profileSource).toLowerCase() === ".jpg" ? "image/jpeg" : "image/png"),
    copyAsset(randomItem(images), "demo/image/", "image/jpeg"),
    copyAsset(randomItem(videos), "demo/video/", "video/mp4"),
  ]);
  return { profile, image, video };
}
function randomUppercase(length) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length }, () => letters[crypto.randomInt(letters.length)]).join("");
}
function createInternationalPhoneNumber() {
  const country = randomItem(COUNTRY_PHONE_FORMATS);
  const phoneNumber = country.template.replace(/#/g, () => String(crypto.randomInt(10)));
  return { ...country, phoneNumber };
}
async function createUniqueAccount(profilePhotoUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const phone = createInternationalPhoneNumber();
    const { phoneNumber } = phone;
    if (phoneNumber === TARGET_PHONE_NUMBER) continue;
    let exists = false;
    try { exists = Boolean(await firestoreManager.readDocument("Users", phoneNumber, "/")); } catch (_error) { /* missing */ }
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
    };
    const user = new UserModel(phoneNumber, profileData, AES.getEncryptedCredential(phoneNumber, personalId));
    await firestoreManager.createDocument("P-ID-MAP", personalId, "/", { phoneNumber });
    await firestoreManager.createDocument("Users", phoneNumber, "/", { ...user });
    await ensureAccountCollections(phoneNumber);
    return { phoneNumber, name, personalId, countryName: phone.countryName, countryIsoCode: phone.countryIsoCode };
  }
  throw new Error("Could not create a unique demo account.");
}
function defaultChatSettings() {
  return { pinned: false, notification_muted: "0", archieved: false, unread_count: 0, last_message: null };
}
async function addChatToList(phoneNumber, chatId, lastMessage) {
  let current = null;
  try { current = await firestoreManager.readDocument("ChatsList", phoneNumber, "/"); } catch (_error) { /* missing */ }
  const stored = current?.list;
  const list = Array.isArray(stored) ? Object.fromEntries(stored.map((id) => [id, defaultChatSettings()])) : stored && typeof stored === "object" ? stored : {};
  const data = { list: { ...list, [chatId]: { ...defaultChatSettings(), ...(list[chatId] || {}), last_message: lastMessage } } };
  if (current) await firestoreManager.updateDocument("ChatsList", phoneNumber, "/", data);
  else await firestoreManager.createDocument("ChatsList", phoneNumber, "/", data);
}
function baseMessage({ chatId, senderId, receiverId, messageType, sentTime, sequence }) {
  return {
    id: `${sentTime}-${sequence}`, clientMessageId: `demo-${crypto.randomUUID()}`, chatId, senderId, receiverId,
    text: "", messageType, sentTime, deliveredTime: sentTime + 250, readTime: sentTime + 500,
    status: "seen", invisible: [],
  };
}
async function createAttachment({ chatId, senderId, messageId, messageType, asset, sentTime }) {
  const mimeTypes = { image: "image/jpeg", video: "video/mp4", audio: "audio/mp4", file: "application/octet-stream" };
  const attachment = {
    id: crypto.randomUUID(), chatId, uploaderId: senderId, kind: messageType, name: asset.fileName,
    mimeType: mimeTypes[messageType], size: asset.size, fullPath: asset.fullPath, url: asset.url,
    status: "attached", createdTime: sentTime, completedTime: sentTime, messageId,
    attachedTime: sentTime, sha256: asset.sha256, demo: true,
  };
  await firestoreManager.createDocument("ChatAttachments", attachment.id, "/", attachment);
  const { id, kind, name, mimeType, size, url, sha256 } = attachment;
  return { id, kind, name, mimeType, size, url, sha256 };
}
async function createMessage({ chatId, senderId, receiverId, messageType, sentTime, sequence, assets }) {
  const message = baseMessage({ chatId, senderId, receiverId, messageType, sentTime, sequence });
  if (messageType === "text") message.text = `Demo text message ${sequence + 1}`;
  if (["image", "video", "audio", "file"].includes(messageType)) {
    const asset = messageType === "image" ? assets.image : assets.video;
    message.text = `Demo ${messageType} attachment`;
    message.attachment = await createAttachment({ chatId, senderId, messageId: message.id, messageType, asset, sentTime });
  }
  if (messageType === "location") {
    message.text = "Demo location: New Delhi";
    message.location = { latitude: 28.6139, longitude: 77.2090, accuracy: 10 };
  }
  if (messageType === "voice_call" || messageType === "video_call") {
    const durationSeconds = 5 + sequence % 176;
    Object.assign(message, {
      clientMessageId: null, callId: crypto.randomUUID(),
      text: messageType === "video_call" ? "Video Call" : "Voice Call", callDurationSeconds: durationSeconds,
      callCreatedAt: sentTime - (durationSeconds + 3) * 1000, callRingingAt: sentTime - (durationSeconds + 2) * 1000,
      callConnectedAt: sentTime - durationSeconds * 1000, callEndedAt: sentTime,
      callTerminationReason: "hangup", callerText: "Outgoing call", receiverText: "Incoming call",
    });
  }
  if (messageType === "report") Object.assign(message, { text: "Message reported for demo testing", reportReason: "demo_report", reportedMessageId: "demo-reported-message" });
  if (messageType === "chat_report") Object.assign(message, { text: "Chat reported for demo testing", reportReason: "demo_chat_report", reportedChatId: chatId });
  if (messageType === "chat_block") message.text = "Chat blocked";
  if (messageType === "chat_unblock") message.text = "Chat unblocked";
  if (messageType === "group_system") Object.assign(message, { text: "Demo member joined the group", groupSystemAction: "member_joined", affectedUserId: senderId });
  return message;
}
async function startExecution(options = {}) {
  const messageCount = validateMessageCount(options.messageCount ?? readMessageCount());
  if (messageCount < MESSAGE_TYPES.length) console.warn(`Coverage warning: ${messageCount} messages cannot contain all ${MESSAGE_TYPES.length} types. Use --messages ${MESSAGE_TYPES.length} or more.`);
  const assets = await prepareDemoAssets();
  const account = await createUniqueAccount(assets.profile.url);
  const chatId = `${account.phoneNumber}_${TARGET_PHONE_NUMBER}`;
  const messageTypes = buildRandomizedSequence(MESSAGE_TYPES, messageCount);
  const now = Date.now();
  const messages = {};
  for (let index = 0; index < messageCount; index += 1) {
    const outgoing = index % 2 === 0;
    const message = await createMessage({ chatId, senderId: outgoing ? account.phoneNumber : TARGET_PHONE_NUMBER,
      receiverId: outgoing ? TARGET_PHONE_NUMBER : account.phoneNumber, messageType: messageTypes[index],
      sentTime: now - (messageCount - index) * 1000, sequence: index, assets });
    messages[message.id] = forStorage(message);
  }
  const writeResult = await upsertShardedEntries("Chats", chatId, messages);
  const latestMessage = Object.values(messages).sort((a, b) => a.sentTime - b.sentTime).at(-1);
  await Promise.all([addChatToList(account.phoneNumber, chatId, latestMessage), addChatToList(TARGET_PHONE_NUMBER, chatId, latestMessage)]);
  const includedTypes = [...new Set(messageTypes)];
  console.log(`Created ${messageCount} messages in sharded chat ${chatId}.`);
  console.log(`Included types: ${includedTypes.join(", ")}.`);
  return { account, chatId, messageCount, messageTypes: includedTypes, writeResult };
}

module.exports = { COUNTRY_PHONE_FORMATS, MESSAGE_TYPES, buildRandomizedSequence, createInternationalPhoneNumber, createMessage, readMessageCount, startExecution };
if (require.main === module) startExecution().catch((error) => { console.error("Demo execution failed:", error); process.exitCode = 1; });
