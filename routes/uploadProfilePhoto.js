const express = require("express");
const sharp = require("sharp");
const FirestoreManager = require("../Firestore/FirestoreManager");
const AES = require("../utils/AES_256");
const { deleteFile, saveFile } = require("../utils/fileStorage");

const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_FORMATS = new Set(["jpeg", "png", "webp"]);

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

    const sourceBuffer = Buffer.from(profilePhotoBase64, "base64");
    if (sourceBuffer.length > MAX_PROFILE_PHOTO_BYTES) {
      return res.status(413).json({
        success: false,
        message: "Profile photo must be 5 MB or smaller.",
      });
    }

    if (!(await isSupportedImage(sourceBuffer))) {
      return res.status(400).json({
        success: false,
        message: "Profile photo must be a valid JPEG, PNG, or WebP image.",
      });
    }

    const processedImage = await sharp(sourceBuffer, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const fileName = `${safeFileName(uid)}--${Date.now()}.webp`;
    const savedFile = await saveFile({
      buffer: processedImage,
      requestedPath: `profile_photo/${fileName}`,
      originalName: fileName,
      mimeType: "image/webp",
    });
    const publicBaseUrl = process.env.PUBLIC_BASE_URL
      ? process.env.PUBLIC_BASE_URL.replace(/\/$/, "")
      : `${getPublicProtocol(req)}://${req.get("host")}${(process.env.PUBLIC_PATH_PREFIX || "/pinggo-app-api").replace(/\/$/, "")}`;
    const profilePhotoUrl = `${publicBaseUrl}${savedFile.publicPath}`;
    const updatedUserData = {
      ...userData,
      profileData: {
        ...(userData.profileData || {}),
        profilePhotoUrl,
      },
    };
    delete updatedUserData._id;

    try {
      await firestoreManager.updateDocument("Users", uid, "/", updatedUserData);
    } catch (error) {
      await deleteFile(savedFile.fullPath).catch(() => null);
      throw error;
    }

    const previousPhotoPath = getManagedProfilePhotoPath(userData.profileData?.profilePhotoUrl);
    if (previousPhotoPath && previousPhotoPath !== savedFile.fullPath) {
      await deleteFile(previousPhotoPath).catch((error) => {
        console.error("Could not delete previous profile photo:", error.message);
      });
    }

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

async function isSupportedImage(imageBuffer) {
  try {
    const metadata = await sharp(imageBuffer, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    }).metadata();
    return Boolean(
      SUPPORTED_IMAGE_FORMATS.has(metadata.format) && metadata.width && metadata.height,
    );
  } catch (_error) {
    return false;
  }
}

function getManagedProfilePhotoPath(photoUrl) {
  if (typeof photoUrl !== "string" || !photoUrl) return null;
  try {
    const pathname = new URL(photoUrl, "http://local").pathname;
    const match = decodeURIComponent(pathname).match(
      /\/(?:files\/)?(profile_photos?\/[a-zA-Z0-9._-]+)$/,
    );
    return match ? match[1] : null;
  } catch (_error) {
    return null;
  }
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
