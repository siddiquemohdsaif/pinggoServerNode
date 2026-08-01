const FirestoreManager = require("../Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();

function generateRandomString_A(length) {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

async function getP_ID_Doc(P_ID) {
    try {
        const document = await firestoreManager.readDocument("P-ID-MAP", P_ID, "/");
        return document || false;
    } catch (error) {
        return false;
    }
}

async function generateP_ID() {
    for (let i = 0; i < 20; i++) {
        const P_ID = generateRandomString_A(9);
        const pIdDoc = await getP_ID_Doc(P_ID);
        if (!pIdDoc) {
            return P_ID;
        }
    }
    throw new Error("failed to create account x001");
}

async function createP_ID_DOC(P_ID, phoneNumber) {
    try {
        const createResult = await firestoreManager.createDocument("P-ID-MAP", P_ID, "/", { phoneNumber });
        if (createResult) {
            return createResult;
        }
        throw new Error("failed to create account x002");
    } catch (error) {
        throw new Error("failed to create account x003");
    }
}

module.exports = {
    generateP_ID,
    getP_ID_Doc,
    createP_ID_DOC
};
