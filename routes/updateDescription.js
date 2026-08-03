const express = require("express");
const { updateProfileField } = require("./profileUpdateUtils");

const router = express.Router();

router.post("/", async (req, res) => {
  return updateProfileField(req, res, "description", req.body.description, validateDescription);
});

function validateDescription(description) {
  if (!description) {
    return "description is required.";
  }
  if (description.length > 500) {
    return "description is too long.";
  }
  return null;
}

module.exports = router;
