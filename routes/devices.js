"use strict";

const express = require("express");
const AES = require("../utils/AES_256");
const { registerDevice, listDevices, listOldDevices, revokeDevice, getDevice,
  getPrimaryFcmTokens, revokeAllDevices, MAX_DEVICES } = require("../models/DeviceStore");
const { disconnectDevice, disconnectAccount,
  notifyDeviceUnlinked, resolveUnlinkActorDeviceId } = require("../realtime/connectionManager");
const { sendSessionLogoutNotification,
  sendDeviceActivityNotification } = require("../realtime/fcmService");

const router = express.Router();
const UserDeviceInfo = require("../models/UserDeviceInfoStore");

router.get("/history", async (req, res) => {
  try { return res.json({ success: true, devices: await listOldDevices(AES.getAuthUid(req)) }); }
  catch (error) { return fail(res, error); }
});
router.get("/user-info", async (req, res) => {
  try { return res.json({ success: true, devices: await UserDeviceInfo.listDevices(AES.getAuthUid(req)) }); }
  catch (error) { return fail(res, error); }
});
router.post("/login", async (req, res) => {
  try {
    const accountId = AES.getAuthUid(req);
    const body = req.body || {};
    if (req.auth.deviceId && req.auth.deviceId !== body.deviceId)
      return res.status(403).json({ success: false, message: "Device credential mismatch." });
    const existingDevice = body.deviceId
      ? await UserDeviceInfo.getDevice(accountId, body.deviceId) : null;
    // Capture recipients before saving the new device so the device being registered
    // cannot receive its own new-login alert.
    const previousPrimaryTokens = !req.auth.deviceId && !existingDevice
      ? await getPrimaryFcmTokens(accountId) : [];
    const device = await registerDevice(accountId, {
      ...body, role: req.auth.deviceId ? "companion" : "primary",
    }, { login: true });
    res.json({ success: true, device });
    if (previousPrimaryTokens.length > 0) {
      sendDeviceActivityNotification({
        accountId,
        event: "device_login",
        device,
        actorDeviceId: device.deviceId,
        tokens: previousPrimaryTokens,
      }).catch((error) => console.error(
        "Could not send new-device-login notification:", error.message));
    }
    return undefined;
  } catch (error) { return fail(res, error); }
});

router.get("/", async (req, res) => {
  try {
    const accountId = AES.getAuthUid(req);
    return res.json({ success: true, maxDevices: MAX_DEVICES,
      devices: await listDevices(accountId), serverTime: Date.now() });
  } catch (error) { return fail(res, error); }
});

router.post("/register", async (req, res) => {
  try {
    const accountId = AES.getAuthUid(req);
    const body = req.body || {};
    if (req.auth.deviceId && req.auth.deviceId !== body.deviceId) {
      return res.status(403).json({ success: false, message: "Device credential mismatch." });
    }
    const device = await registerDevice(accountId, {
      ...body,
      role: req.auth.deviceId ? "companion" : "primary",
    });
    return res.json({ success: true, device });
  } catch (error) { return fail(res, error); }
});

router.post("/heartbeat", async (req, res) => {
  try {
    const accountId = AES.getAuthUid(req);
    const body = req.body || {};
    if (req.auth.deviceId && req.auth.deviceId !== body.deviceId) {
      return res.status(403).json({ success: false, message: "Device credential mismatch." });
    }
    const device = await registerDevice(accountId, {
      ...body,
      role: req.auth.deviceId ? "companion" : "primary",
    });
    return res.json({ success: true, device, serverTime: Date.now() });
  } catch (error) { return fail(res, error); }
});

router.post("/logout", async (req, res) => {
  try {
    const accountId = AES.getAuthUid(req);
    const deviceId = String((req.body || {}).deviceId || "").trim();
    if (req.auth.deviceId && req.auth.deviceId !== deviceId) {
      return res.status(403).json({ success: false, message: "Device credential mismatch." });
    }
    const device = await getDevice(accountId, deviceId);
    if (!device) {
      return res.status(404).json({ success: false, message: "Device not found." });
    }
    if (device.role === "companion") {
      return res.status(400).json({ success: false,
        message: "Companion devices must use the unlink operation." });
    }
    const loggedOutAt = Date.now();
    await UserDeviceInfo.logoutDevice(accountId, deviceId, "self_logout", loggedOutAt);
    res.json({ success: true, deviceId, loggedOutAt });
    setImmediate(() => disconnectDevice(accountId, deviceId, 4003, "Device logged out."));
    return undefined;
  } catch (error) { return fail(res, error); }
});

router.post("/logout-account", async (req, res) => {
  try {
    const accountId = AES.getAuthUid(req);
    const body = req.body || {};
    const actorDeviceId = req.auth.deviceId || String(body.deviceId || "").trim();
    const actor = actorDeviceId ? await getDevice(accountId, actorDeviceId) : null;
    if (req.auth.deviceId && (!actor || actor.revokedAt || actor.role !== "primary")) {
      return res.status(403).json({ success: false,
        message: "Only the primary device can log out the account." });
    }
    const result = await revokeAllDevices(accountId);
    res.status(200).json({ success: true, revokedAt: result.revokedAt,
      revokedCount: result.revokedCount });
    setImmediate(() => disconnectAccount(accountId, {
      type: "account_logout",
      reason: "The primary device logged out of this Pinggo account.",
      revokedAt: result.revokedAt,
    }));
    sendSessionLogoutNotification({ tokens: result.notificationTokens,
      accountId, revokedAt: result.revokedAt,
      reason: "primary_logout",
      message: "You were logged out because the primary device logged out of this account.",
    }).catch(() => null);
    return undefined;
  } catch (error) { return fail(res, error); }
});

router.delete("/:deviceId", async (req, res) => {
  try {
    const accountId = AES.getAuthUid(req);
    const actorDeviceId = req.auth.deviceId;
    if (actorDeviceId && actorDeviceId !== req.params.deviceId) {
      const actor = await getDevice(accountId, actorDeviceId);
      if (!actor || actor.revokedAt || actor.role !== "primary") {
        return res.status(403).json({ success: false,
          message: "Only the primary device can log out another device." });
      }
    }
    const targetDevice = await getDevice(accountId, req.params.deviceId);
    const revoked = await revokeDevice(accountId, req.params.deviceId);
    if (revoked) {
      const revokedAt = Date.now();
      // Normal primary credentials are account-bound and intentionally have no deviceId.
      // A distinct marker prevents a primary removal from looking like companion self-logout.
      const effectiveActorDeviceId = resolveUnlinkActorDeviceId(actorDeviceId);
      const removedByPrimary = effectiveActorDeviceId !== req.params.deviceId;
      notifyDeviceUnlinked(accountId, req.params.deviceId,
        effectiveActorDeviceId, revokedAt);
      // Let the target socket flush device_unlinked (including the user-facing reason)
      // before starting its close handshake. FCM remains the fallback for offline devices.
      setTimeout(() => disconnectDevice(
        accountId, req.params.deviceId, 4003,
        removedByPrimary ? "Device was unlinked by the primary device."
          : "Device was unlinked.",
      ), 250);
      sendSessionLogoutNotification({
        tokens: targetDevice && targetDevice.fcmToken ? [targetDevice.fcmToken] : [],
        accountId,
        revokedAt,
        reason: removedByPrimary ? "device_unlinked" : "self_logout",
        message: removedByPrimary
          ? "This companion device was logged out by the primary device." : "",
      }).then((result) => {
        console.log(`[device-unlink-fcm] accountId=${accountId}`
          + ` deviceId=${req.params.deviceId} delivered=${Boolean(result && result.success)}`
          + ` skipped=${Boolean(result && result.skipped)}`);
      }).catch((error) => console.error("Could not notify unlinked companion:", error.message));
      if (targetDevice && targetDevice.role === "companion") {
        sendDeviceActivityNotification({
          accountId,
          event: "device_unlinked",
          device: targetDevice,
          actorDeviceId: effectiveActorDeviceId,
        }).catch((error) => console.error(
          "Could not send device-unlinked notification:", error.message));
      }
    }
    return res.status(revoked ? 200 : 404).json({ success: revoked,
      message: revoked ? "Device unlinked." : "Device not found." });
  } catch (error) { return fail(res, error); }
});

function fail(res, error) {
  return res.status(error.statusCode || 400).json({ success: false, message: error.message });
}

module.exports = router;
