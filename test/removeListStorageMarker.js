"use strict";

const { isDeepStrictEqual } = require("node:util");
const MARKER = "__listStorage";
const COLLECTIONS = { ChatsList: "list", CallsList: "list", UserBlocks: "blockedUsers",
  LinkedDevices: "devices", GroupsList: "members" };

function cleanupPlan(collection, document) {
  if (!Object.hasOwn(COLLECTIONS, collection)) throw new Error("Unsupported list collection.");
  if (!document || !Object.hasOwn(document, MARKER)) return null;
  const marker = document[MARKER];
  if (!marker || marker.version !== 1 || marker.field !== COLLECTIONS[collection]
      || !marker.metadata || typeof marker.metadata !== "object" || Array.isArray(marker.metadata))
    throw new Error("Unsupported list marker; refusing to remove it.");
  const updates = {};
  for (const [key, value] of Object.entries(marker.metadata)) {
    if (key === "_id" || key === MARKER) throw new Error("Reserved metadata field: " + key);
    if (Object.hasOwn(document, key) && !isDeepStrictEqual(document[key], value))
      throw new Error("Metadata conflicts with existing field: " + key);
    if (!Object.hasOwn(document, key)) Object.defineProperty(updates, key,
      { value, enumerable: true, configurable: true, writable: true });
  }
  return { updates, marker };
}

async function removeMarkers(firestore, { collections = Object.keys(COLLECTIONS),
    execute = false, report = console.log } = {}) {
  if (collections.some(name => !Object.hasOwn(COLLECTIONS, name)))
    throw new Error("Unsupported list collection.");
  let matched = 0;
  for (const collection of collections) {
    const ids = await firestore.readCollectionDocumentIds(collection, "/");
    for (const id of ids) {
      const document = await firestore.readDocument(collection, id, "/");
      if (!document) throw new Error(`Document disappeared: ${collection}/${id}`);
      const plan = cleanupPlan(collection, document);
      if (!plan) continue;
      matched++;
      report(JSON.stringify({ mode: execute ? "execute" : "dry-run", collection, id,
        metadataFieldsToRestore: Object.keys(plan.updates).length }));
      if (!execute) continue;
      if (Object.keys(plan.updates).length)
        await firestore.updateDocument(collection, id, "/", { ...plan.updates });
      const latest = await firestore.readDocument(collection, id, "/");
      if (!latest || !isDeepStrictEqual(latest[MARKER], plan.marker))
        throw new Error(`Marker changed during cleanup: ${collection}/${id}`);
      for (const [key, value] of Object.entries(plan.marker.metadata)) {
        if (!isDeepStrictEqual(latest[key], value))
          throw new Error(`Metadata verification failed: ${collection}/${id}`);
      }
      await firestore.deleteField(collection, "/", id, MARKER);
    }
  }
  return { matched, execute };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg.startsWith("--") && arg !== "--execute"))
    throw new Error("Usage: node test/removeListStorageMarker.js [--execute] [ChatsList ...]");
  const requested = args.filter(arg => !arg.startsWith("--"));
  const execute = args.includes("--execute");
  console.log(execute ? "EXECUTE: marker cleanup" : "DRY RUN: no database writes");
  const FirestoreManager = require("../Firestore/FirestoreManager");
  const result = await removeMarkers(FirestoreManager.getInstance(), {
    collections: requested.length ? requested : Object.keys(COLLECTIONS), execute });
  console.log(JSON.stringify(result));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { cleanupPlan, removeMarkers };
