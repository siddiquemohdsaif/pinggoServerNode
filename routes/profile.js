const express = require("express");
const uploadProfilePhoto = require("./uploadProfilePhoto");
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

module.exports = router;
