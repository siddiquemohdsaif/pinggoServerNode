"use strict";

const FirestoreManager = require("../Firestore/FirestoreManager");

const firestore = FirestoreManager.getInstance();

async function readOrNull(collection, accountId) {
  try { return (await firestore.readDocument(collection, accountId, "/")) || null; }
  catch (_error) { return null; }
}

async function ensureListDocument(collection, accountId) {
  const existing = await readOrNull(collection, accountId);
  if (existing) return existing;
  try {
    return await firestore.createDocument(collection, accountId, "/", {});
  } catch (_error) {
    const concurrentlyCreated = await readOrNull(collection, accountId);
    if (concurrentlyCreated) return concurrentlyCreated;
    throw _error;
  }
}

async function ensureAccountCollections(accountId) {
  const normalized = String(accountId || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");
  if (!normalized) throw new Error("accountId is required.");
  await ensureListDocument("ChatsList", normalized);
}

module.exports = { ensureAccountCollections };
