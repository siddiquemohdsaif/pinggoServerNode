const FirestoreManager = require("../Firestore/FirestoreManager");

const firestore = FirestoreManager.getInstance();
const MAX_ENTRIES = 2000;
// Leave headroom below Firestore's 1 MiB document limit for field-name and encoding overhead.
const MAX_ESTIMATED_BYTES = 800 * 1024;
const META_COLLECTION = "Metadata";
const INDEX_DOCUMENT = "ChatsDocList";
const PINNED_DOCUMENT = "Pinned_Message";
const locks = new Map();

function withoutId(value) {
  const copy = { ...(value || {}) };
  delete copy._id;
  return copy;
}

function parentPath(rootCollection, rootId) {
  return `/${rootCollection}/${rootId}`;
}

function batchCollection(kind) {
  return kind === "calls" ? "CallBatches" : "MessageBatches";
}

function estimatedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
}

function batchId(now = Date.now()) {
  const date = new Date(now);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${date.getFullYear()}-${now}`;
}

async function readOrNull(collection, documentId, parent = "/") {
  try { return (await firestore.readDocument(collection, documentId, parent)) || null; }
  catch (_error) { return null; }
}

async function upsert(collection, documentId, parent, value) {
  if (await readOrNull(collection, documentId, parent)) {
    return firestore.updateDocument(collection, documentId, parent, withoutId(value));
  }
  try {
    return await firestore.createDocument(collection, documentId, parent, withoutId(value));
  } catch (_createError) {
    // FirestoreManager mutates its input by appending _id, so every attempt must
    // receive a fresh object. This path also handles a concurrent create.
    return firestore.updateDocument(collection, documentId, parent, withoutId(value));
  }
}

async function ensureRoot(rootCollection, rootId) {
  if (await readOrNull(rootCollection, rootId, "/")) return;
  try { await firestore.createDocument(rootCollection, rootId, "/", {}); }
  catch (_error) { /* A concurrent request may have created it. */ }
}

async function ensureShardedContainer(rootCollection, rootId, kind = "messages") {
  await ensureRoot(rootCollection, rootId);
  const parent = parentPath(rootCollection, rootId);
  if (!await readOrNull(META_COLLECTION, INDEX_DOCUMENT, parent)) {
    try {
      await firestore.createDocument(META_COLLECTION, INDEX_DOCUMENT, parent, {
        batches: [], batchIds: [], currentBatch: null,
        maxEntries: MAX_ENTRIES, maxEstimatedBytes: MAX_ESTIMATED_BYTES,
        updatedAt: Date.now(),
      });
    } catch (_error) {
      if (!await readOrNull(META_COLLECTION, INDEX_DOCUMENT, parent)) throw _error;
    }
  }
  if (kind === "messages") {
    if (!await readOrNull(META_COLLECTION, PINNED_DOCUMENT, parent)) {
      try { await firestore.createDocument(META_COLLECTION, PINNED_DOCUMENT, parent, {}); }
      catch (_error) {
        if (!await readOrNull(META_COLLECTION, PINNED_DOCUMENT, parent)) throw _error;
      }
    }
  }
}

function normalizeIndex(document, discoveredIds = []) {
  const raw = withoutId(document);
  const metadata = Array.isArray(raw.batches) ? raw.batches : [];
  const byId = new Map(metadata.map((item) => [typeof item === "string" ? item : item.id,
    typeof item === "string" ? { id: item } : { ...item }]));
  discoveredIds.forEach((id) => { if (!byId.has(id)) byId.set(id, { id }); });
  const batches = [...byId.values()].filter((item) => item.id).sort((a, b) =>
    Number(a.createdAt || String(a.id).split("-").pop() || 0)
      - Number(b.createdAt || String(b.id).split("-").pop() || 0));
  return { batches, currentBatch: raw.currentBatch || batches.at(-1)?.id || null };
}

async function readState(rootCollection, rootId, kind) {
  const parent = parentPath(rootCollection, rootId);
  const collection = batchCollection(kind);
  const [indexDocument, discoveredIds] = await Promise.all([
    readOrNull(META_COLLECTION, INDEX_DOCUMENT, parent),
    firestore.readCollectionDocumentIds(collection, parent).catch(() => []),
  ]);
  const index = normalizeIndex(indexDocument, discoveredIds);
  const documents = {};
  await Promise.all(index.batches.map(async (metadata) => {
    const document = await readOrNull(collection, metadata.id, parent);
    if (document) documents[metadata.id] = withoutId(document);
  }));
  return { parent, collection, index, documents };
}

async function readShardedMap(rootCollection, rootId, kind = "messages") {
  const state = await readState(rootCollection, rootId, kind);
  const combined = {};
  state.index.batches.forEach(({ id }) => Object.assign(combined, state.documents[id] || {}));
  return Object.keys(combined).length ? combined : null;
}

function isPinned(message) {
  return Boolean(message && ((Array.isArray(message.pinned) && message.pinned.length > 0)
    || message.pinned === true || message.pinned === "true"));
}

async function syncPinned(rootCollection, rootId, entries) {
  const parent = parentPath(rootCollection, rootId);
  const additions = {};
  const removals = [];
  Object.entries(entries).forEach(([id, message]) => {
    if (isPinned(message)) additions[id] = message;
    else removals.push(id);
  });
  if (Object.keys(additions).length) {
    await upsert(META_COLLECTION, PINNED_DOCUMENT, parent, additions);
  }
  if (await readOrNull(META_COLLECTION, PINNED_DOCUMENT, parent)) {
    await Promise.all(removals.map((id) =>
      firestore.deleteField(META_COLLECTION, parent, PINNED_DOCUMENT, id).catch(() => null)));
  }
}

async function writeEntries(rootCollection, rootId, entries, kind) {
  await ensureRoot(rootCollection, rootId);
  const state = await readState(rootCollection, rootId, kind);
  const locations = new Map();
  Object.entries(state.documents).forEach(([documentId, document]) => {
    Object.keys(document).forEach((entryId) => locations.set(entryId, documentId));
  });
  const writes = new Map();
  const metadata = new Map(state.index.batches.map((item) => [item.id, { ...item }]));
  let currentBatch = state.index.currentBatch;

  for (const [entryId, value] of Object.entries(entries || {})) {
    const existingDocumentId = locations.get(entryId);
    let documentId = existingDocumentId || currentBatch;
    let document = documentId ? { ...(state.documents[documentId] || {}) } : {};
    const isNew = !locations.has(entryId) && !Object.prototype.hasOwnProperty.call(document, entryId);
    const candidate = { ...document, [entryId]: value };
    if (!documentId || (isNew && (Object.keys(candidate).length > MAX_ENTRIES
        || estimatedBytes(candidate) > MAX_ESTIMATED_BYTES))) {
      let now = Date.now();
      documentId = batchId(now);
      while (metadata.has(documentId)) documentId = batchId(++now);
      document = {};
      currentBatch = documentId;
    }
    document[entryId] = value;
    state.documents[documentId] = document;
    writes.set(documentId, { ...(writes.get(documentId) || {}), [entryId]: value });
    locations.set(entryId, documentId);
    metadata.set(documentId, {
      id: documentId,
      count: Object.keys(document).length,
      estimatedBytes: estimatedBytes(document),
      createdAt: Number(metadata.get(documentId)?.createdAt)
        || Number(documentId.split("-").pop()) || Date.now(),
    });
    if (!existingDocumentId) currentBatch = documentId;
  }

  for (const [documentId, documentUpdates] of writes) {
    await upsert(state.collection, documentId, state.parent, documentUpdates);
  }
  const batches = [...metadata.values()].sort((a, b) => a.createdAt - b.createdAt);
  await upsert(META_COLLECTION, INDEX_DOCUMENT, state.parent, {
    batches,
    batchIds: batches.map((item) => item.id),
    currentBatch,
    maxEntries: MAX_ENTRIES,
    maxEstimatedBytes: MAX_ESTIMATED_BYTES,
    updatedAt: Date.now(),
  });
  if (kind === "messages") await syncPinned(rootCollection, rootId, entries);
  return { batches, currentBatch };
}

async function upsertShardedEntries(rootCollection, rootId, entries, kind = "messages") {
  const key = `${rootCollection}/${rootId}/${kind}`;
  const previous = locks.get(key) || Promise.resolve();
  const operation = previous.catch(() => null).then(() =>
    writeEntries(rootCollection, rootId, entries, kind));
  locks.set(key, operation);
  try { return await operation; }
  finally { if (locks.get(key) === operation) locks.delete(key); }
}

async function deleteShardCollections(rootCollection, rootId) {
  const parent = parentPath(rootCollection, rootId);
  for (const collection of ["MessageBatches", "CallBatches", META_COLLECTION]) {
    // Propagate transport failures so cleanup callers can retry. Swallowing a timeout here
    // could delete the root document while leaving its batch subcollections orphaned.
    await firestore.deleteCollection(collection, parent);
  }
}

module.exports = {
  MAX_ENTRIES,
  MAX_ESTIMATED_BYTES,
  deleteShardCollections,
  ensureShardedContainer,
  readShardedMap,
  upsertShardedEntries,
};
