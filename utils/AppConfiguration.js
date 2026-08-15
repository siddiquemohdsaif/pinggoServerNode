const FirestoreManager = require('../Firestore/FirestoreManager');
const firestoreManager = FirestoreManager.getInstance();

const COLLECTION_NAME = "AppConfiguration";
const INDEX_DOCUMENT_NAME = "AppConfiguration";
const PARENT_PATH = "/";
const CACHE_TTL_MS = 10000;

// Global cache for AppConfiguration
let appConfigCache = {
    data: null,
    timestamp: null
};

const get = async () => {
    const now = Date.now();

    // Check if appConfig is in cache and not older than 10 seconds
    if (appConfigCache.data && (now - appConfigCache.timestamp) < CACHE_TTL_MS) {
        return appConfigCache.data;
    }

    // The index document contains the names of the versioned config documents.
    const configIndex = await firestoreManager.readDocument(
        COLLECTION_NAME,
        INDEX_DOCUMENT_NAME,
        PARENT_PATH
    );
    const configDocumentNames = configIndex && configIndex.config;

    if (!Array.isArray(configDocumentNames) || configDocumentNames.length === 0) {
        throw new Error("AppConfiguration.config must contain at least one document name.");
    }

    // The last entry is the active/latest configuration document.
    const configDocumentName = configDocumentNames[configDocumentNames.length - 1];
    if (typeof configDocumentName !== "string" || !configDocumentName) {
        throw new Error("AppConfiguration.config contains an invalid document name.");
    }

    const appConfig = await firestoreManager.readDocument(
        COLLECTION_NAME,
        configDocumentName,
        PARENT_PATH
    );

    appConfigCache = {
        data: appConfig,
        timestamp: Date.now()
    };

    return appConfig;
};

module.exports = {
    get
};
