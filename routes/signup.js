const express = require("express");
const FirestoreManager = require("../Firestore/FirestoreManager");
const UserModel = require("../models/UserModel");
const AES = require("../utils/AES_256");
const { generateP_ID, createP_ID_DOC } = require("../utils/signupUtils");

const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const name = normalizeString(req.body.name);
    const phoneNumber = normalizeString(
      req.body.phoneNumber || req.body.phone_number || req.body.phone,
    );
    const description = normalizeString(req.body.description);

    const validationError = validateSignup({ name, phoneNumber, description });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const accountId = formatPhoneNumberForAccountId(phoneNumber);
    const existingUserData = await getUserByPhoneNumber(accountId);
    if (existingUserData) {
      return res.status(200).json({
        success: true,
        message: "User already exists.",
        userData: existingUserData,
      });
    }

    const P_ID = await generateP_ID();
    await createP_ID_DOC(P_ID, accountId);

    const profileData = {
      name,
      phoneNumber: accountId,
      description,
      P_ID,
    };

    const userModel = new UserModel(
      accountId,
      profileData,
      AES.getEncryptedCredential(accountId, P_ID),
    );

    await firestoreManager.createDocument("Users", accountId, "/", userModel);

    await firestoreManager.createDocument("ChatsList", accountId, "/", {
      list: [],
    });

    return res.status(200).json({
      success: true,
      userData: userModel,
    });
  } catch (error) {
    console.error("Error in signup:", error.message);
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
  if (phoneNumber.startsWith("+")) {
    return `<plus>${phoneNumber.slice(1)}`;
  }
  return phoneNumber;
}

async function getUserByPhoneNumber(phoneNumber) {
  try {
    const userDoc = await firestoreManager.readDocument(
      "Users",
      phoneNumber,
      "/",
    );
    return userDoc || false;
  } catch (error) {
    return false;
  }
}

function validateSignup({ name, phoneNumber, description }) {
  if (!name) {
    return "name is required.";
  }
  if (!phoneNumber) {
    return "phoneNumber is required.";
  }
  if (!description) {
    return "description is required.";
  }
  if (name.length > 80) {
    return "name is too long.";
  }
  if (description.length > 500) {
    return "description is too long.";
  }
  if (!/^\+?[0-9]{7,15}$/.test(phoneNumber)) {
    return "phoneNumber must contain 7 to 15 digits and may start with +.";
  }
  return null;
}

module.exports = router;
