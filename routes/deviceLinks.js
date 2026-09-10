"use strict";

const express = require("express");
const AES = require("../utils/AES_256");
const { getDevice, isDeviceRevoked } = require("../models/DeviceStore");
const { DevicePairingService } = require("../services/devicePairingService");
const { sendToUser } = require("../realtime/connectionManager");
const { sendDeviceActivityNotification } = require("../realtime/fcmService");

const router = express.Router();
const pairing = new DevicePairingService();

router.post("/", async (req, res) => respond(res,
  () => pairing.createLinkRequest(req.body)));

router.post("/:linkRequestId/approve", async (req, res) => {
  const claims = AES.getHeaderCredentialClaims(req);
  if (!claims) {
    return res.status(401).json({ success: false, message: "Authorization failed." });
  }
  const body = req.body || {};
  const approvingDeviceId = typeof body.approvingDeviceId === "string"
    ? body.approvingDeviceId.trim() : "";
  if (claims.deviceId && claims.deviceId !== approvingDeviceId) {
    return res.status(401).json({ success: false, message: "Device credential mismatch." });
  }
  if (approvingDeviceId && await isDeviceRevoked(claims.uid, approvingDeviceId)) {
    return res.status(401).json({ success: false, message: "This device has been logged out." });
  }
  const approvingDevice = approvingDeviceId ? await getDevice(claims.uid, approvingDeviceId) : null;
  if (approvingDevice && approvingDevice.role !== "primary") {
    return res.status(403).json({ success: false,
      message: "Only the primary device can link another device." });
  }
  return respond(res, () => pairing.approve({
    accountId: claims.uid,
    approvingDeviceId,
    linkRequestId: req.params.linkRequestId,
    pairingSecret: body.pairingSecret,
  }));
});

router.post("/:linkRequestId/status", async (req, res) => respond(res,
  () => pairing.status({ linkRequestId: req.params.linkRequestId,
    pairingSecret: (req.body || {}).pairingSecret })));

router.post("/:linkRequestId/complete", async (req, res) => {
  try {
    const result = await pairing.complete({ linkRequestId: req.params.linkRequestId,
      pairingSecret: (req.body || {}).pairingSecret });
    sendToUser(result.accountId, { type: "device_linked", device: result.device },
      (socket, payload) => {
        if (socket.readyState === undefined || socket.readyState === 1) {
          try { socket.send(JSON.stringify(payload)); } catch (_error) {}
        }
      });
    sendDeviceActivityNotification({
      accountId: result.accountId,
      event: "device_linked",
      device: result.device,
      actorDeviceId: result.deviceId,
    }).catch((error) => console.error("Could not send device-linked notification:", error.message));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
});

async function respond(res, operation) {
  try { return res.status(200).json({ success: true, ...(await operation()) }); }
  catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
}

module.exports = router;
