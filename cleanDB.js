const FirestoreManager = require("./Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();

// Keep this list synchronized with the collections used by routes/, realtime/, models/, and utils/.
// Chats contains every message type (0..11), including voice_call and video_call timeline messages.
// CallsList contains each user's latest call per chat; CallLogs contains history by chatId.
// ChatAttachments contains metadata only; this script does not delete uploaded files from disk/storage.
// AppConfiguration is intentionally preserved because the server requires it after a database reset.
const COLLECTIONS_TO_CLEAN = [
    "ChatAttachments",
    "GroupAttachments",
    "CallLogs",
    "CallsList",
    "Reports",
    "UserBlocks",
    "Chats",
    "GroupsChat",
    "GroupsList",
    "ChatsList",
    "EmailOtp",
    "P-ID-MAP",
    "Users",
];

const cleanCollection = async (collectionName) => {
    const documentIds = await firestoreManager.readCollectionDocumentIds(
        collectionName,
        "/"
    );

    for (let index = 0; index < documentIds.length; index += 50) {
        const batch = documentIds.slice(index, index + 50);

        await Promise.all(
            batch.map((documentId) =>
                firestoreManager.deleteDocument(collectionName, documentId, "/")
            )
        );

        console.log(
            `${collectionName}: deleted ${Math.min(index + 50, documentIds.length)} of ${documentIds.length}`
        );

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (documentIds.length === 0) {
        console.log(`${collectionName}: already empty`);
    }

    return documentIds.length;
};

const cleanDB = async () => {
    let totalDeleted = 0;
    const summary = {};

    for (const collectionName of COLLECTIONS_TO_CLEAN) {
        console.log(`Cleaning: ${collectionName}`);
        const deleted = await cleanCollection(collectionName);
        summary[collectionName] = deleted;
        totalDeleted += deleted;
    }

    console.log("Database cleanup complete.");
    for (const [collectionName, deleted] of Object.entries(summary)) {
        console.log(`  ${collectionName}: ${deleted} document(s)`);
    }
    console.log(`Total deleted: ${totalDeleted} document(s)`);
};

cleanDB().catch((error) => {
    console.error("Database cleanup failed:", error);
    process.exitCode = 1;
});
