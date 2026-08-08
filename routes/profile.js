const express = require("express");
const uploadProfilePhoto = require("./uploadProfilePhoto");
const { getPresenceForUsers } = require("../realtime/presenceService");
const { updateProfileField } = require("../utils/profileUpdateUtils");

const router = express.Router();

router.post("/updateName", async (req, res) => {
  return updateProfileField(req, res, "name", req.body.name, validateName);
});

router.post("/updateDescription", async (req, res) => {
  return updateProfileField(
    req,
    res,
    "description",
    req.body.description,
    validateDescription,
  );
});

router.post("/updateDob", async (req, res) => {
  return updateProfileField(req, res, "dob", req.body.dob, validateDob);
});

router.post("/updateEmail", async (req, res) => {
  return updateProfileField(req, res, "email", req.body.email, validateEmail);
});

router.post("/updateFcmToken", async (req, res) => {
  return updateProfileField(
    req,
    res,
    "fcmToken",
    req.body.fcmToken || req.body.deviceToken || req.body.token,
    validateFcmToken,
  );
});

router.post("/presence", async (req, res) => {
  try {
    const userIds = req.body.userIds || req.body.phoneNumbers || req.body.users;
    const validationError = validatePresenceRequest(userIds);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const presence = await getPresenceForUsers(userIds);
    return res.status(200).json({
      success: true,
      presence,
      syncTime: Date.now(),
    });
  } catch (error) {
    console.error("Error in presence:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.use("/uploadProfilePhoto", uploadProfilePhoto);

function validateName(name) {
  if (!name) {
    return "name is required.";
  }
  if (name.length > 80) {
    return "name is too long.";
  }
  return null;
}

function validateDescription(description) {
  if (!description) {
    return "description is required.";
  }
  if (description.length > 500) {
    return "description is too long.";
  }
  return null;
}

function validateDob(dob) {
  if (!dob) {
    return "dob is required.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return "dob must use YYYY-MM-DD format.";
  }
  return null;
}

function validateEmail(email) {
  if (!email) {
    return "email is required.";
  }
  if (email.length > 254) {
    return "email is too long.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "email is not valid.";
  }
  return null;
}

function validateFcmToken(fcmToken) {
  if (!fcmToken) {
    return "fcmToken is required.";
  }
  if (fcmToken.length > 4096) {
    return "fcmToken is too long.";
  }
  return null;
}

function validatePresenceRequest(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return "userIds must be a non-empty array.";
  }
  if (userIds.some((userId) => typeof userId !== "string" || !userId.trim())) {
    return "userIds must contain non-empty strings.";
  }
  if (userIds.length > 200) {
    return "userIds must contain 200 users or fewer.";
  }
  return null;
}

module.exports = router;
