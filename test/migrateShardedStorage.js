const FirestoreManager = require("../Firestore/FirestoreManager");
const { readShardedMap, upsertShardedEntries } = require("../models/ShardedDocumentStore");

const firestore = FirestoreManager.getInstance();
const execute = process.argv.includes("--execute");

function withoutId(document) {
  const copy = { ...(document || {}) };
  delete copy._id;
  return copy;
}

function storedEntries(document) {
  return Object.fromEntries(Object.entries(withoutId(document))
    .filter(([, value]) => value && typeof value === "object"));
}

async function migrateCollection(collection, kind) {
  const ids = await firestore.readCollectionDocumentIds(collection, "/");
  const result = { containers: ids.length, migrated: 0, entries: 0, legacyFieldsDeleted: 0 };
  for (const id of ids) {
    let legacy;
    try { legacy = await firestore.readDocument(collection, id, "/"); }
    catch (_error) { continue; }
    const entries = storedEntries(legacy);
    const entryIds = Object.keys(entries);
    if (!entryIds.length) continue;
    console.log(`${execute ? "Migrating" : "Would migrate"} ${collection}/${id}: ${entryIds.length} entries`);
    if (!execute) continue;
    await upsertShardedEntries(collection, id, entries, kind);
    const migrated = await readShardedMap(collection, id, kind);
    const missing = entryIds.filter((entryId) => !migrated || !migrated[entryId]);
    if (missing.length) throw new Error(`${collection}/${id}: verification failed for ${missing.length} entries.`);
    for (const entryId of entryIds) {
      await firestore.deleteField(collection, "/", id, entryId);
      result.legacyFieldsDeleted += 1;
    }
    result.migrated += 1;
    result.entries += entryIds.length;
  }
  return result;
}

async function main() {
  if (!execute) console.log("Dry run only. Pass --execute to write batches.");
  const summary = {
    Chats: await migrateCollection("Chats", "messages"),
    GroupsChat: await migrateCollection("GroupsChat", "messages"),
    CallLogs: await migrateCollection("CallLogs", "calls"),
  };
  console.log("Migration summary:", JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("Sharded-storage migration failed:", error);
  process.exitCode = 1;
});
