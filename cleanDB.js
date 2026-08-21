const FirestoreManager = require("./Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();

const COLLECTIONS_TO_CLEAN = [
    // "P-ID-MAP",
    // "EmailOtp",
    // "Chats",
    // "Users",
    // "ChatsList",
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
};

const cleanDB = async () => {
    for (const collectionName of COLLECTIONS_TO_CLEAN) {
        console.log(`Cleaning: ${collectionName}`);
        await cleanCollection(collectionName);
    }

    console.log("Database cleanup complete.");
};

cleanDB().catch((error) => {
    console.error("Database cleanup failed:", error);
    process.exitCode = 1;
});
