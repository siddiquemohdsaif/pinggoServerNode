const FirestoreManager = require("../Firestore/FirestoreManager");
const { readAttachment, saveAttachment } = require("../models/ChatAttachmentStore");

const firestore = FirestoreManager.getInstance();
const execute = process.argv.includes("--execute");

async function migrateCollection(collection) {
  const documentIds = await firestore.readCollectionDocumentIds(collection, "/");
  let discovered = 0;
  let migrated = 0;
  let skipped = 0;
  for (const documentId of documentIds) {
    let attachment;
    try { attachment = await firestore.readDocument(collection, documentId, "/"); }
    catch (_error) { attachment = null; }
    const chatId = String(attachment && attachment.chatId || "").trim();
    if (!chatId || (collection === "GroupAttachments") !== chatId.startsWith("grp_")) {
      skipped += 1;
      continue;
    }
    discovered += 1;
    if (!execute) continue;
    const value = { ...attachment, id: attachment.id || documentId };
    delete value._id;
    await saveAttachment(chatId, value);
    const verified = await readAttachment(chatId, value.id);
    if (!verified || verified.chatId !== chatId) {
      throw new Error(`Unable to verify ${collection}/${documentId}.`);
    }
    await firestore.deleteDocument(collection, documentId, "/");
    migrated += 1;
  }
  return { collection, discovered, migrated, skipped };
}

async function main() {
  const results = [];
  results.push(await migrateCollection("ChatAttachments"));
  results.push(await migrateCollection("GroupAttachments"));
  console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", results }, null, 2));
}

main().catch((error) => {
  console.error("Attachment migration failed:", error);
  process.exitCode = 1;
});
