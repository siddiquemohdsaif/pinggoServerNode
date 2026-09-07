const express = require("express");
const { getCallsList, getCallLogs } = require("../models/CallLogStore");

const router = express.Router();

router.post("/list", async (req, res) => {
  try {
    const phoneNumber = String(req.body.phoneNumber || "")
      .trim().replace(/^<plus>/, "").replace(/^\+/, "");
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: "phoneNumber is required." });
    }
    const page = await getCallsList(phoneNumber, req.body.pageSize, req.body.cursor);
    return res.json({ success: true, ...page });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/logs", async (req, res) => {
  try {
    const phoneNumber = String(req.body.phoneNumber || "")
      .trim().replace(/^<plus>/, "").replace(/^\+/, "");
    const chatId = String(req.body.chatId || "").trim();
    if (!phoneNumber || !chatId) {
      return res.status(400).json({
        success: false, message: "phoneNumber and chatId are required.",
      });
    }
    const page = await getCallLogs(
      phoneNumber, chatId, req.body.pageSize, req.body.cursor,
    );
    return res.json({ success: true, ...page });
  } catch (error) {
    return res.status(error.statusCode || 500)
      .json({ success: false, message: error.message });
  }
});

module.exports = router;
