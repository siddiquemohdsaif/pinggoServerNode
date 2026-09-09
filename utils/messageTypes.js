"use strict";

const MESSAGE_TYPE_CODES = Object.freeze({
  text: 0,
  image: 1,
  video: 2,
  audio: 3,
  file: 4,
  location: 5,
  voice_call: 6,
  video_call: 7,
  report: 8,
  chat_report: 9,
  chat_block: 10,
  chat_unblock: 11,
  group_system: 12,
});

const MESSAGE_TYPES = Object.freeze(Object.fromEntries(
  Object.entries(MESSAGE_TYPE_CODES).map(([name, code]) => [code, name]),
));

function normalizeName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function encodeMessageType(value) {
  const name = normalizeName(value);
  if (!Object.prototype.hasOwnProperty.call(MESSAGE_TYPE_CODES, name)) {
    throw new TypeError(`Invalid message type: ${value}`);
  }
  return MESSAGE_TYPE_CODES[name];
}

function decodeMessageType(value) {
  if (!Number.isInteger(value) || !Object.prototype.hasOwnProperty.call(MESSAGE_TYPES, value)) {
    throw new TypeError(`Invalid message type code: ${value}`);
  }
  return MESSAGE_TYPES[value];
}

// Storage and transport use full descriptive field names with a numeric messageType.
// Compact legacy fields and string types are deliberately not accepted here.
function forStorage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError("Message must be an object.");
  }
  if (Object.prototype.hasOwnProperty.call(message, "t")) {
    throw new TypeError("Legacy compact message fields are not supported.");
  }
  const messageType = Number.isInteger(message.messageType)
    ? (decodeMessageType(message.messageType), message.messageType)
    : encodeMessageType(message.messageType);
  return { ...message, messageType };
}

function forClient(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError("Message must be an object.");
  }
  if (Object.prototype.hasOwnProperty.call(message, "t")) {
    throw new TypeError("Legacy compact message fields are not supported.");
  }
  return { ...message, messageType: decodeMessageType(message.messageType) };
}

function mapChat(chat, mapper) {
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) {
    throw new TypeError("Chat must be an object.");
  }
  return Object.fromEntries(Object.entries(chat).map(([key, value]) =>
    [key, key === "_id" ? value : mapper(value)]));
}

function chatForInternal(chat) {
  return mapChat(chat, forClient);
}

function chatForClient(chat) {
  return mapChat(chat, forStorage);
}

module.exports = {
  MESSAGE_TYPE_CODES,
  encodeMessageType,
  decodeMessageType,
  forStorage,
  forClient,
  chatForClient,
  chatForInternal,
};
