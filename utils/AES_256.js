const crypto = require('crypto');

const KEY_64 = 'Xj3D3KN6nGq3L2eOxQ56Zq065YTCmRs+CRgbHOo0Uwk=';
const KEY = Buffer.from(KEY_64, 'base64');
const IV_LENGTH = 16;

function encrypt(message) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
    let encrypted = cipher.update(message, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return iv.toString('base64') + encrypted;
}

function decrypt(encryptedMessage) {
    let iv = Buffer.from(encryptedMessage.slice(0, 24), 'base64');
    let encryptedText = encryptedMessage.slice(24);
    let decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
    let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function getEncryptedCredential(UID , cc_id) {
    return encrypt(UID+"_"+cc_id);
}

function validateEncryptedCredentialByUID(enc, UID) {
    try {
        const decrypted = decrypt(enc);
        const [decryptedUID, _] = decrypted.split('_');
        return decryptedUID === UID;
    } catch (error) {
        return false;
    }
}

function validateEncryptedCredentialByCCID(enc, cc_id) {
    try {
        const decrypted = decrypt(enc);
        const [_, decryptedCCID] = decrypted.split('_');
        return decryptedCCID === cc_id;
    } catch (error) {
        return false;
    }
}

function validateEncryptedCredentialByHeader(req) {
    try {
        const authHeader = req.headers.authorization;

        // Check if Authorization header exists and starts with 'Bearer '
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return false;
        }

        // Extract the token from the header and split it into UID and enc
        const token = authHeader.split(' ')[1];
        const [uidFromToken, enc] = token.split('_');

        if (!uidFromToken || !enc) {
            return false;
        }

        // Validate the encrypted token using the UID from the token itself
        return validateEncryptedCredentialByUID(enc, uidFromToken);
    } catch (error) {
        console.error("Error validating encrypted credential by header:", error.message);
        return false;
    }
}


function getAuthUid(req) {
    try {
        const authHeader = req.headers.authorization;

        // Check if Authorization header exists and starts with 'Bearer '
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return "null";
        }

        // Extract the token from the header and split it into UID and enc
        const token = authHeader.split(' ')[1];
        const [uidFromToken, _] = token.split('_');
        
        return uidFromToken;
    } catch (error) {
        return "null";
    }
}


module.exports = {
    encrypt,
    decrypt,
    getEncryptedCredential,
    validateEncryptedCredentialByUID,
    validateEncryptedCredentialByCCID,
    getAuthUid,
    validateEncryptedCredentialByHeader
};