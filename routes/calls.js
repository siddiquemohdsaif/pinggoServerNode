const express = require("express");
const { deleteCallLogs, getCallsList, getCallLogs } = require("../models/CallLogStore");
const { createParticipantToken, isLiveKitConfigured, missingLiveKitVariables } = require("../services/livekitService");
const groupService = require("../services/groupService");
const { canJoinLiveKitCall } = require("../realtime/callHandler");

const router = express.Router();

router.post("/livekit/token", async (req, res) => {
  try {
    if (!isLiveKitConfigured()) {
      const missing = missingLiveKitVariables();
      console.error(`[livekit-token] rejected reason=not_configured missing=${missing.join(",")}`);
      return res.status(503).json({
        success: false,
        code: "LIVEKIT_NOT_CONFIGURED",
        message: `LiveKit server is missing: ${missing.join(", ")}`,
      });
    }
    const callId = String(req.body.callId || "").trim();
    const chatId = String(req.body.chatId || "").trim();
    const mediaType = req.body.mediaType === "video" ? "video" : "audio";
    if (!callId || !chatId) {
      return res.status(400).json({ success: false, message: "callId and chatId are required." });
    }
    const userId = String(req.auth.userId || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");
    if (canJoinLiveKitCall(callId, userId)) {
      // Members dynamically invited to an active direct call may not belong to its chat.
    } else if (chatId.startsWith("grp_")) {
      groupService.requireMember(await groupService.readGroup(chatId), userId);
    } else if (!chatId.split("_").map((value) => value.replace(/^<plus>/, "").replace(/^\+/, ""))
      .includes(userId)) {
      return res.status(403).json({ success: false, message: "Call access denied." });
    }
    const roomName = `pinggo_${callId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const token = await createParticipantToken({ roomName, userId, mediaType });
    console.log(`[livekit-token] issued callId=${callId} chatId=${chatId}`
      + ` userId=${userId} room=${roomName} media=${mediaType}`);
    return res.json({
      success: true,
      engine: "livekit",
      callId,
      chatId,
      roomName,
      mediaType,
      serverUrl: process.env.LIVEKIT_URL,
      participantToken: token,
    });
  } catch (error) {
    console.error(`[livekit-token] failed callId=${req.body.callId || ""}`
      + ` userId=${req.auth?.userId || ""} error=${error.message}`);
    return res.status(error.statusCode || 500)
      .json({ success: false, message: error.message || "Could not create LiveKit token." });
  }
});

router.post("/list", async (req, res) => {
  try {
    const phoneNumber = String(req.auth && req.auth.userId || "")
      .trim().replace(/^<plus>/, "").replace(/^\+/, "");
    if (!phoneNumber) {
      return res.status(401).json({ success: false, message: "Authentication is required." });
    }
    const page = await getCallsList(phoneNumber, req.body.pageSize, req.body.cursor);
    return res.json({ success: true, ...page });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/logs", async (req, res) => {
  try {
    const phoneNumber = String(req.auth && req.auth.userId || "")
      .trim().replace(/^<plus>/, "").replace(/^\+/, "");
    const chatId = String(req.body.chatId || "").trim();
    if (!phoneNumber || !chatId) {
      return res.status(400).json({
        success: false, message: "Authentication and chatId are required.",
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

router.post("/logs/delete", async (req, res) => {
  try {
    const phoneNumber = String(req.auth && req.auth.userId || "")
      .trim().replace(/^<plus>/, "").replace(/^\+/, "");
    const callIds = Array.isArray(req.body.callIds)
      ? req.body.callIds : [req.body.callId].filter(Boolean);
    const result = await deleteCallLogs(phoneNumber, callIds);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 500)
      .json({ success: false, message: error.message });
  }
});

module.exports = router;
