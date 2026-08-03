const express = require("express");
const { updateProfileField } = require("./profileUpdateUtils");

const router = express.Router();

router.post("/", async (req, res) => {
  return updateProfileField(req, res, "name", req.body.name, validateName);
});

function validateName(name) {
  if (!name) {
    return "name is required.";
  }
  if (name.length > 80) {
    return "name is too long.";
  }
  return null;
}

module.exports = router;
