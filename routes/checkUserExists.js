const express = require("express");
const FirestoreManager = require("../Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const phoneNumber = normalizeString(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const validationError = validatePhoneNumber(phoneNumber);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const userData = await getUserByPhoneNumber(accountId);
    if (!userData) {
      return res.status(200).json({
        success: true,
        exists: false,
        email: null,
      });
    }

    const email = normalizeString(
      userData.profileData && userData.profileData.email,
    );
    return res.status(200).json({
      success: true,
      exists: true,
      email: email || null,
    });
  } catch (error) {
    console.error("Error checking whether user exists:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validatePhoneNumber(phoneNumber) {
  if (!phoneNumber) return "phoneNumber is required.";
  if (!/^\+?[0-9]{7,15}$/.test(phoneNumber)) {
    return "phoneNumber must contain 7 to 15 digits and may start with +.";
  }
  return null;
}

function formatPhoneNumberForAccountId(phoneNumber) {
  return phoneNumber.startsWith("+")
    ? `<plus>${phoneNumber.slice(1)}`
    : phoneNumber;
}

async function getUserByPhoneNumber(phoneNumber) {
  try {
    const userData = await firestoreManager.readDocument(
      "Users",
      phoneNumber,
      "/",
    );
    return userData || null;
  } catch (error) {
    return null;
  }
}

module.exports = router;
