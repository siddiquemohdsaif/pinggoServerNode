const express = require("express");
const GoogleAuthUtil = require("../utils/googleAuthUtil");

const router = express.Router();

router.post("/google", (req, res) => GoogleAuthUtil.verify(req, res));

module.exports = router;
