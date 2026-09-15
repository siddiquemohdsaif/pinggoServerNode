const express = require("express");
const GoogleAuthUtil = require("../utils/googleAuthUtil");
const { rateLimit } = require("../services/rateLimitService");

const router = express.Router();

router.post("/google", rateLimit({ namespace: "google-auth", limit: 20,
  windowSeconds: 15 * 60, identity: (req) => req.ip }),
  (req, res) => GoogleAuthUtil.verify(req, res));

module.exports = router;
