const express = require("express");
const SmsUtils = require("../utils/smsUtils");
const EmailUtil = require("../utils/emailUtil");
const { rateLimit } = require("../services/rateLimitService");

const router = express.Router();
const otpIdentity = (req) => req.body && (req.body.identifier || req.body.mobile
  || req.body.phoneNumber || req.body.phone || req.body.email) || req.ip;
const otpSendLimit = rateLimit({ namespace: "otp-send", limit: 5,
  windowSeconds: 10 * 60, identity: otpIdentity });
const otpVerifyLimit = rateLimit({ namespace: "otp-verify", limit: 10,
  windowSeconds: 10 * 60, identity: otpIdentity });

router.post("/smsSend", otpSendLimit, (req, res) => SmsUtils.smsSend(req, res));
router.post("/smsVerify", otpVerifyLimit, (req, res) => SmsUtils.smsVerify(req, res));
router.post("/smsResend", otpSendLimit, (req, res) => SmsUtils.smsResend(req, res));
router.post("/emailSend", otpSendLimit, (req, res) => EmailUtil.emailSend(req, res));
router.post("/emailVerify", otpVerifyLimit, (req, res) => EmailUtil.emailVerify(req, res));
router.post("/emailResend", otpSendLimit, (req, res) => EmailUtil.emailResend(req, res));

module.exports = router;
