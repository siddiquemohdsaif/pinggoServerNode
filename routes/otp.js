const express = require("express");
const SmsUtils = require("../utils/smsUtils");
const EmailUtil = require("../utils/emailUtil");

const router = express.Router();

router.post("/smsSend", (req, res) => SmsUtils.smsSend(req, res));
router.post("/smsVerify", (req, res) => SmsUtils.smsVerify(req, res));
router.post("/smsResend", (req, res) => SmsUtils.smsResend(req, res));
router.post("/emailSend", (req, res) => EmailUtil.emailSend(req, res));
router.post("/emailVerify", (req, res) => EmailUtil.emailVerify(req, res));
router.post("/emailResend", (req, res) => EmailUtil.emailResend(req, res));

module.exports = router;
