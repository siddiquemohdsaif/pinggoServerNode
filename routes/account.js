"use strict";

const express = require("express");
const AES = require("../utils/AES_256");
const { accountId, deleteAccount } = require("../services/accountDeletionService");
const { disconnectAccount } = require("../realtime/connectionManager");

const router = express.Router();

router.post("/delete", async (req, res) => {
  try {
    const authenticatedId = accountId(AES.getAuthUid(req));
    const confirmedId = accountId(req.body && req.body.phoneNumber);
    if (!confirmedId || confirmedId !== authenticatedId) {
      return res.status(400).json({ success: false,
        message: "Enter the phone number of the signed-in account." });
    }
    const result = await deleteAccount(authenticatedId);
    // Notify every currently connected installation before completing the request.
    // This includes the deleting device and all linked companion devices.
    const disconnectedDevices = disconnectAccount(authenticatedId, {
      type: "account_logout",
      reason: "account_deleted",
      message: "This Pinggo account was deleted.",
      revokedAt: result.revokedAt || Date.now(),
    });
    console.log(`[account-delete] accountId=${authenticatedId}`
      + ` websocketLogouts=${disconnectedDevices}`);
    return res.status(200).json({ success: true, deleted: true,
      disconnectedDevices });
  } catch (error) {
    console.error("Account deletion failed:", error);
    return res.status(error.statusCode || 500).json({ success: false,
      message: "Could not delete the account. No local data was removed; please try again." });
  }
});

module.exports = router;
