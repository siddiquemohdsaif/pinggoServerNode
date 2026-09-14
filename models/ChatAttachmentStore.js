const FirestoreManager = require("../Firestore/FirestoreManager");
const { readShardedMap, upsertShardedEntries } = require("./ShardedDocumentStore");

const firestore = FirestoreManager.getInstance();

function collectionForChat(chatId) {
  return String(chatId || "").startsWith("grp_")
    ? "GroupAttachments" : "ChatAttachments";
}

function withoutId(value) {
  const copy = { ...(value || {}) };
  delete copy._id;
  return copy;
}

async function saveAttachment(chatId, attachment) {
  const id = String(attachment && attachment.id || "").trim();
  if (!id) throw new Error("Attachment id is required.");
  await upsertShardedEntries(collectionForChat(chatId), chatId, {
    [id]: withoutId(attachment),
  }, "attachments");
  return attachment;
}

async function readAttachment(chatId, attachmentId) {
  const id = String(attachmentId || "").trim();
  if (!id) return null;
  const collection = collectionForChat(chatId);
  const attachments = await readShardedMap(collection, chatId, "attachments");
  if (attachments && attachments[id]) return { ...attachments[id], id };

  // Read and lazily migrate attachments created with the previous flat schema.
  try {
    const legacy = await firestore.readDocument(collection, id, "/");
    if (!legacy || legacy.chatId !== chatId) return null;
    const migrated = { ...withoutId(legacy), id: legacy.id || id };
    await saveAttachment(chatId, migrated);
    return migrated;
  } catch (_error) {
    return null;
  }
}

async function updateAttachment(chatId, attachmentId, updates) {
  const current = await readAttachment(chatId, attachmentId);
  if (!current) return null;
  const updated = { ...current, ...withoutId(updates), id: current.id || attachmentId };
  await saveAttachment(chatId, updated);
  return updated;
}

module.exports = {
  collectionForChat,
  readAttachment,
  saveAttachment,
  updateAttachment,
};
