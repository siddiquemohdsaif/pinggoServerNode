const express = require("express");
const FirestoreManager = require("../Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );

    const validationError = validateLogin({ phoneNumber });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const userDoc = await getUserByPhoneNumber(accountId);

    if (userDoc) {
      return res.status(200).json({
        success: true,
        userData: userDoc,
      });
    }

    return res.status(404).json({ success: false, message: "No user found." });
  } catch (error) {
    console.error("Error in login:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function formatPhoneNumberForAccountId(phoneNumber) {
  return normalizePhoneNumber(phoneNumber);
}

function normalizePhoneNumber(value) {
  return normalizeString(value).replace(/^<plus>/, "").replace(/^\+/, "");
}

async function getUserByPhoneNumber(phoneNumber) {
  try {
    const userDoc = await firestoreManager.readDocument("Users", phoneNumber, "/");
    return userDoc || false;
  } catch (error) {
    return false;
  }
}

function validateLogin({ phoneNumber }) {
  if (!phoneNumber) {
    return "phoneNumber is required.";
  }

  if (!/^[0-9]{7,15}$/.test(phoneNumber)) {
    return "phoneNumber must contain 7 to 15 digits.";
  }

  return null;
}

module.exports = router;
