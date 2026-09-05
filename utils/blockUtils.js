const FirestoreManager = require("../Firestore/FirestoreManager");
const firestoreManager = FirestoreManager.getInstance();

async function isBlockedBy(ownerId, otherId) {
  const owner = normalize(ownerId);
  const other = normalize(otherId);
  if (!owner || !other) return false;
  try {
    const document = await firestoreManager.readDocument("UserBlocks", owner, "/");
    return Boolean(document && document.blockedUsers && document.blockedUsers[other]);
  } catch (_error) {
    return false;
  }
}

async function setBlocked(ownerId, otherId, chatId, blocked) {
  const owner = normalize(ownerId);
  const other = normalize(otherId);
  let document = null;
  try {
    document = await firestoreManager.readDocument("UserBlocks", owner, "/");
  } catch (_error) {
    document = null;
  }
  const blockedUsers = { ...((document && document.blockedUsers) || {}) };
  if (blocked) blockedUsers[other] = { chatId, blockedAt: Date.now() };
  else delete blockedUsers[other];
  const value = { ownerId: owner, blockedUsers, updatedAt: Date.now() };
  if (document) await firestoreManager.updateDocument("UserBlocks", owner, "/", value);
  else await firestoreManager.createDocument("UserBlocks", owner, "/", value);
  return value.updatedAt;
}

function normalize(value) {
  return (typeof value === "string" ? value.trim() : "")
    .replace(/^<plus>/, "").replace(/^\+/, "");
}

module.exports = { isBlockedBy, setBlocked };
