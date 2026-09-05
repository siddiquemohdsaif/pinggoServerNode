const express = require("express");
const { getCallLogs } = require("../models/CallLogStore");

const router = express.Router();

router.post("/list", async (req, res) => {
  try {
    const phoneNumber = String(req.body.phoneNumber || "")
      .trim().replace(/^<plus>/, "").replace(/^\+/, "");
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: "phoneNumber is required." });
    }
    return res.json({ success: true, calls: await getCallLogs(phoneNumber) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
