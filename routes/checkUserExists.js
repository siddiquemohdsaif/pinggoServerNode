const express = require("express");
const FirestoreManager = require("../Firestore/FirestoreManager");
const { beginReactivation, reactivateAccount } = require("../services/accountDeletionService");

const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const validationError = validatePhoneNumber(phoneNumber);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const userData = await getUserByPhoneNumber(accountId);
    if (!userData) {
      const reactivationToken = await beginReactivation(accountId);
      return res.status(200).json({
        success: true,
        exists: false,
        deleted: Boolean(reactivationToken),
        reactivationToken,
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

router.post("/reactivate", async (req, res) => {
  try {
    const phoneNumber = normalizePhoneNumber(req.body && req.body.phoneNumber);
    const validationError = validatePhoneNumber(phoneNumber);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const userData = await reactivateAccount(phoneNumber,
      normalizeString(req.body && req.body.reactivationToken));
    return res.status(200).json({ success: true, reactivated: true,
      email: normalizeString(userData.profileData && userData.profileData.email) || null });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validatePhoneNumber(phoneNumber) {
  if (!phoneNumber) return "phoneNumber is required.";
  if (!/^[0-9]{7,15}$/.test(phoneNumber)) {
    return "phoneNumber must contain 7 to 15 digits.";
  }
  return null;
}

function formatPhoneNumberForAccountId(phoneNumber) {
  return normalizePhoneNumber(phoneNumber);
}

function normalizePhoneNumber(value) {
  return normalizeString(value).replace(/^<plus>/, "").replace(/^\+/, "");
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
