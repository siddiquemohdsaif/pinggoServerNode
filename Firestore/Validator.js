function validateDocumentName(documentName) {
    if (documentName === null) {
        throw new Error("document name is null");
    }

    if (documentName === "") {
        throw new Error("document name is empty");
    }

    if (documentName.includes("`")) {
        throw new Error("document name have a restricted character (`)");
    }

    if (documentName.includes("/")) {
        throw new Error("document name have a restricted character (/)");
    }

    if (documentName.includes(" ")) {
        throw new Error("document name have a restricted character (space)");
    }
}

function validateCollectionName(collectionName) {
    if (collectionName === null) {
        throw new Error("collection name is null");
    }

    if (collectionName === "") {
        throw new Error("collection name is empty");
    }

    if (collectionName.includes("`")) {
        throw new Error("collection name have a restricted character (`)");
    }

    if (collectionName.includes("/")) {
        throw new Error("collection name have a restricted character (/)");
    }

    if (collectionName.includes(" ")) {
        throw new Error("collection name have a restricted character (space)");
    }
}

module.exports = {
    validateDocumentName,
    validateCollectionName,
};