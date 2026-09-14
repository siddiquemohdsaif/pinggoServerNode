"use strict";

require("dotenv").config();

const FirestoreManager = require("../Firestore/FirestoreManager");
const { readShardedMap } = require("../models/ShardedDocumentStore");
const { updateAttachment } = require("../models/ChatAttachmentStore");

const firestoreManager = FirestoreManager.getInstance();

function withoutId(document) {
  const copy = { ...document };
  delete copy._id;
  return copy;
}

function isMessage(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isSafeInteger(Number(value.sentTime)) &&
      Number(value.sentTime) > 0,
  );
}

function buildMigrationPlan(chatId, chatDocument) {
  const messages = Object.entries(chatDocument || {}).filter(([, value]) =>
    isMessage(value),
  );
  const newIds = new Set();
  const idMap = new Map();

  for (const [fieldId, message] of messages) {
    const timestampId = String(Number(message.sentTime));
    if (newIds.has(timestampId)) {
      throw new Error(
        `Chat ${chatId} contains multiple messages with sentTime ${timestampId}.`,
      );
    }
    newIds.add(timestampId);
    idMap.set(fieldId, timestampId);
    if (message.id) idMap.set(String(message.id), timestampId);
  }

  const writes = {};
  const oldFieldIds = [];
  for (const [fieldId, message] of messages) {
    const timestampId = idMap.get(fieldId);
    const migratedMessage = { ...message, id: timestampId };
    const migratedReplyId = idMap.get(String(message.repliedMessageId || ""));
    if (migratedReplyId) migratedMessage.repliedMessageId = migratedReplyId;
    writes[timestampId] = migratedMessage;
    if (fieldId !== timestampId) oldFieldIds.push(fieldId);
  }

  return { chatId, idMap, messages, oldFieldIds, writes };
}

async function updateAttachmentReferences(plans) {
  const plansByChatId = new Map(plans.map((plan) => [plan.chatId, plan]));
  let updated = 0;

  // Current chat-scoped attachment batches.
  for (const plan of plans) {
    const attachments = await readShardedMap(
      "ChatAttachments", plan.chatId, "attachments");
    for (const [attachmentId, attachment] of Object.entries(attachments || {})) {
      const newMessageId = plan.idMap.get(String(attachment.messageId || ""));
      if (!newMessageId || newMessageId === attachment.messageId) continue;
      await updateAttachment(plan.chatId, attachmentId, { messageId: newMessageId });
      updated += 1;
    }
  }

  // Previous flat attachment documents.
  const attachmentIds = await firestoreManager.readCollectionDocumentIds(
    "ChatAttachments",
    "/",
  );

  for (const attachmentId of attachmentIds) {
    let attachment;
    try {
      attachment = await firestoreManager.readDocument(
        "ChatAttachments",
        attachmentId,
        "/",
      );
    } catch (_error) {
      continue;
    }

    const plan = plansByChatId.get(attachment && attachment.chatId);
    const newMessageId = plan && plan.idMap.get(String(attachment.messageId || ""));
    if (!newMessageId || newMessageId === attachment.messageId) continue;

    await firestoreManager.updateDocument(
      "ChatAttachments",
      attachmentId,
      "/",
      { ...withoutId(attachment), messageId: newMessageId },
    );
    updated += 1;
  }

  return updated;
}

async function startExecution() {
  const chatIds = await firestoreManager.readCollectionDocumentIds("Chats", "/");
  const plans = [];

  // Validate every chat before writing anything, especially duplicate timestamps.
  for (const chatId of chatIds) {
    const chatDocument = await firestoreManager.readDocument("Chats", chatId, "/");
    plans.push(buildMigrationPlan(chatId, chatDocument));
  }

  let rewrittenMessages = 0;
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (Object.keys(plan.writes).length > 0) {
      // Write timestamp fields first so a failure never deletes the only copy.
      await firestoreManager.updateDocument("Chats", plan.chatId, "/", {
        ...plan.writes,
      });
    }

    for (const oldFieldId of plan.oldFieldIds) {
      await firestoreManager.deleteField("Chats", "/", plan.chatId, oldFieldId);
    }

    rewrittenMessages += plan.messages.length;
    console.log(
      `[${index + 1}/${plans.length}] ${plan.chatId}` +
        ` -> ${plan.messages.length} message(s), ${plan.oldFieldIds.length} old field(s) removed`,
    );
  }

  const updatedAttachments = await updateAttachmentReferences(plans);
  const summary = {
    chats: plans.length,
    rewrittenMessages,
    updatedAttachments,
  };
  console.log("Message ID migration completed:", summary);
  return summary;
}

module.exports = { buildMigrationPlan, startExecution };

if (require.main === module) {
  startExecution().catch((error) => {
    console.error("Message ID migration failed:", error.message);
    process.exitCode = 1;
  });
}
