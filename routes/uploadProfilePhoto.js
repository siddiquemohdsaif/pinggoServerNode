const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const FirestoreManager = require("../Firestore/FirestoreManager");
const AES = require("../utils/AES_256");

const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const uid = AES.getAuthUid(req);
    if (!uid || uid === "null") {
      return res.status(401).json({ success: false, message: "Authorization failed" });
    }

    const profilePhotoBase64 = normalizeString(req.body.profilePhotoBase64);
    const validationError = validateProfilePhoto(profilePhotoBase64);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const userData = await firestoreManager.readDocument("Users", uid, "/");
    if (!userData) {
      return res.status(404).json({ success: false, message: "No user found." });
    }

    const imageBuffer = Buffer.from(profilePhotoBase64, "base64");
    const uploadsDir = path.join(__dirname, "..", "..", "..", "PinggoServerNode", "public", "profile_photos");
    await fs.mkdir(uploadsDir, { recursive: true });

    const fileName = `${safeFileName(uid)}.jpg`;
    const filePath = path.join(uploadsDir, fileName);
    await fs.writeFile(filePath, imageBuffer);

    const profilePhotoUrl = `${getPublicProtocol(req)}://${req.get("host")}/pinggo-app-api/profile_photos/${fileName}`;
    const updatedUserData = {
      ...userData,
      profileData: {
        ...(userData.profileData || {}),
        profilePhotoUrl,
      },
    };
    delete updatedUserData._id;

    await firestoreManager.updateDocument("Users", uid, "/", updatedUserData);

    return res.status(200).json({
      success: true,
      profilePhotoUrl,
      userData: {
        ...updatedUserData,
        _id: uid,
      },
    });
  } catch (error) {
    console.error("Error in uploadProfilePhoto:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function validateProfilePhoto(profilePhotoBase64) {
  if (!profilePhotoBase64) {
    return "profilePhotoBase64 is required.";
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(profilePhotoBase64)) {
    return "profilePhotoBase64 is not valid.";
  }
  return null;
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getPublicProtocol(req) {
  const forwardedProtocol = req.headers["x-forwarded-proto"];
  if (typeof forwardedProtocol === "string" && forwardedProtocol.includes("https")) {
    return "https";
  }

  const host = req.get("host") || "";
  if (host.includes("function.cloudsw3.com")) {
    return "https";
  }

  return req.protocol;
}

module.exports = router;
