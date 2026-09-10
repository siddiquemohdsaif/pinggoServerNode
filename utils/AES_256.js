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
    if (typeof encryptedMessage === 'string' && encryptedMessage.startsWith('v2.')) {
        const parts = encryptedMessage.split('.');
        if (parts.length !== 4) throw new Error('Invalid authenticated credential.');
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const encryptedText = Buffer.from(parts[3], 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
    }
    let iv = Buffer.from(encryptedMessage.slice(0, 24), 'base64');
    let encryptedText = encryptedMessage.slice(24);
    let decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
    let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function encryptAuthenticated(message) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const encrypted = Buffer.concat([cipher.update(message, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v2.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function getEncryptedCredential(UID , cc_id) {
    const message = UID+"_"+cc_id;
    return typeof cc_id === 'string' && cc_id.startsWith('device:')
        ? encryptAuthenticated(message)
        : encrypt(message);
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

function getEncryptedCredentialClaims(enc) {
    try {
        const decrypted = decrypt(enc);
        const separator = decrypted.indexOf('_');
        if (separator < 1) return null;
        const uid = decrypted.slice(0, separator);
        const context = decrypted.slice(separator + 1);
        return {
            uid,
            context,
            deviceId: context.startsWith('device:') ? context.slice('device:'.length) : ''
        };
    } catch (error) {
        return null;
    }
}

function getHeaderCredentialClaims(req) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
        const token = authHeader.slice('Bearer '.length);
        const separator = token.indexOf('_');
        if (separator < 1) return null;
        const uid = token.slice(0, separator);
        const encryptedCredential = token.slice(separator + 1);
        const claims = getEncryptedCredentialClaims(encryptedCredential);
        return claims && claims.uid === uid ? { ...claims, encryptedCredential } : null;
    } catch (error) {
        return null;
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
    validateEncryptedCredentialByHeader,
    getEncryptedCredentialClaims,
    getHeaderCredentialClaims
};
