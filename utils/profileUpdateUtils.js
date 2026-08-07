const FirestoreManager = require("../Firestore/FirestoreManager");
const AES = require("./AES_256");

const firestoreManager = FirestoreManager.getInstance();

async function updateProfileField(req, res, fieldName, value, validateValue) {
  try {
    const uid = AES.getAuthUid(req);
    if (!uid || uid === "null") {
      return res.status(401).json({ success: false, message: "Authorization failed" });
    }

    const normalizedValue = normalizeString(value);
    const validationError = validateValue(normalizedValue);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const userData = await firestoreManager.readDocument("Users", uid, "/");
    if (!userData) {
      return res.status(404).json({ success: false, message: "No user found." });
    }

    const updatedUserData = {
      ...userData,
      profileData: {
        ...(userData.profileData || {}),
        [fieldName]: normalizedValue,
      },
    };
    delete updatedUserData._id;

    await firestoreManager.updateDocument("Users", uid, "/", updatedUserData);

    return res.status(200).json({
      success: true,
      userData: {
        ...updatedUserData,
        _id: uid,
      },
    });
  } catch (error) {
    console.error(`Error in update ${fieldName}:`, error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

module.exports = {
  updateProfileField,
};
