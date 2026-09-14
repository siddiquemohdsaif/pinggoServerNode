const FirestoreManager = require("./Firestore/FirestoreManager");
const { deleteShardCollections } = require("./models/ShardedDocumentStore");

const firestoreManager = FirestoreManager.getInstance();
const DELETE_CONCURRENCY = Math.max(
  1,
  Number(process.env.CLEAN_DB_CONCURRENCY) || 5,
);
const MAX_RETRIES = Math.max(1, Number(process.env.CLEAN_DB_MAX_RETRIES) || 5);
const RETRY_BASE_DELAY_MS = Math.max(
  100,
  Number(process.env.CLEAN_DB_RETRY_DELAY_MS) || 500,
);

// Keep this list synchronized with the collections used by routes/, realtime/, models/, and utils/.
// Chats/GroupsChat store message batches in nested MessageBatches and metadata documents.
// CallsList is retained only for legacy-data cleanup; CallLogs stores history by account id.
// LinkedDevices and DeviceLinkRequests contain account sessions and pending pairing state.
// DeletedAccounts contains deletion/re-registration lifecycle markers and former direct-chat links.
// ChatAttachments/GroupAttachments use chat-scoped MessageBatches. This script removes
// their Firestore metadata but does not delete uploaded files from disk/storage.
// AppConfiguration is intentionally preserved because the server requires it after a database reset.
const COLLECTIONS_TO_CLEAN = [
  "ChatAttachments",
  "GroupAttachments",
  "CallLogs",
  "CallsList",
  "Reports",
  "GroupReports",
  "UserBlocks",
  "DeviceLinkRequests",
  "LinkedDevices",
  "DeletedAccounts",
  "Chats",
  "GroupsChat",
  "GroupsList",
  "ChatsList",
  "EmailOtp",
  "P-ID-MAP",
  "Users",
];

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function isAlreadyDeleted(error) {
  const message = String((error && error.message) || error).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("404") ||
    message.includes("does not exist")
  );
}

function isRetryable(error) {
  const message = String((error && error.message) || error).toLowerCase();
  return [
    "etimedout",
    "econnreset",
    "econnrefused",
    "socket hang up",
    "network",
    "timeout",
    "429",
    "500",
    "502",
    "503",
    "504",
  ].some((value) => message.includes(value));
}

async function withRetry(label, operation) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isAlreadyDeleted(error)) return null;
      if (!isRetryable(error) || attempt === MAX_RETRIES) throw error;
      const waitMs =
        RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) +
        Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
      console.warn(
        `${label}: ${error.message}; retry ${attempt}/${MAX_RETRIES} in ${waitMs} ms`,
      );
      await delay(waitMs);
    }
  }
  return null;
}

async function mapWithConcurrency(items, concurrency, operation) {
  let nextIndex = 0;
  const failures = [];
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        try {
          await operation(item);
        } catch (error) {
          failures.push({ item, error });
        }
      }
    },
  );
  await Promise.all(workers);
  return failures;
}

const cleanCollection = async (collectionName) => {
  const documentIds = await withRetry(`${collectionName}: list documents`, () =>
    firestoreManager.readCollectionDocumentIds(collectionName, "/"),
  );
  const failures = [];

  for (let index = 0; index < documentIds.length; index += 50) {
    const batch = documentIds.slice(index, index + 50);
    const batchFailures = await mapWithConcurrency(
      batch,
      DELETE_CONCURRENCY,
      async (documentId) => {
        if (
          [
            "Chats",
            "GroupsChat",
            "CallLogs",
            "ChatAttachments",
            "GroupAttachments",
          ].includes(collectionName)
        ) {
          await withRetry(
            `${collectionName}/${documentId}: delete shards`,
            () => deleteShardCollections(collectionName, documentId),
          );
        }
        await withRetry(
          `${collectionName}/${documentId}: delete document`,
          () =>
            firestoreManager.deleteDocument(collectionName, documentId, "/"),
        );
      },
    );
    failures.push(...batchFailures);

    console.log(
      `${collectionName}: processed ${Math.min(index + 50, documentIds.length)} of ${documentIds.length}`,
    );
    await delay(100);
  }

  if (documentIds.length === 0) {
    console.log(`${collectionName}: already empty`);
  }

  if (failures.length) {
    failures.forEach(({ item, error }) =>
      console.error(
        `${collectionName}/${item}: delete failed after ${MAX_RETRIES} attempt(s): ${error.message}`,
      ),
    );
  }
  return { deleted: documentIds.length - failures.length, failures };
};

const cleanDB = async () => {
  let totalDeleted = 0;
  const summary = {};
  const failedDocuments = [];

  for (const collectionName of COLLECTIONS_TO_CLEAN) {
    console.log(`Cleaning: ${collectionName}`);
    const result = await cleanCollection(collectionName);
    summary[collectionName] = result.deleted;
    totalDeleted += result.deleted;
    if (result.failures.length)
      failedDocuments.push(
        ...result.failures.map(({ item, error }) => ({
          collectionName,
          documentId: item,
          error,
        })),
      );
  }

  console.log("Database cleanup complete.");
  for (const [collectionName, deleted] of Object.entries(summary)) {
    console.log(`  ${collectionName}: ${deleted} document(s)`);
  }
  console.log(`Total deleted: ${totalDeleted} document(s)`);
  if (failedDocuments.length) {
    throw new Error(
      `${failedDocuments.length} document(s) could not be deleted. Run cleanDB.js again to resume.`,
    );
  }
};

cleanDB().catch((error) => {
  console.error("Database cleanup failed:", error);
  process.exitCode = 1;
});
