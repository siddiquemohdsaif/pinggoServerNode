const express = require("express");
const axios = require("axios");

const router = express.Router();

const MSG91_WIDGET_BASE_URL = "https://control.msg91.com/api/v5/widget";

router.post("/send", async (req, res) => {
  try {
    const identifier = normalizeIdentifier(
      req.body.identifier || req.body.mobile || req.body.phoneNumber || req.body.phone,
    );

    const validationError = validateIdentifier(identifier);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const msg91Response = await callMsg91Widget("/sendOtpMobile", {
      identifier,
    });

    return res.status(200).json({
      success: isMsg91Success(msg91Response),
      ...msg91Response,
    });
  } catch (error) {
    return handleOtpError(res, "send OTP", error);
  }
});

router.post("/verify", async (req, res) => {
  try {
    const reqId = normalizeString(req.body.reqId || req.body.requestId);
    const otp = normalizeString(req.body.otp);

    const validationError = validateVerifyOtp({ reqId, otp });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const msg91Response = await callMsg91Widget("/verifyOtp", {
      reqId,
      otp,
    });

    const verified = isMsg91Success(msg91Response);
    return res.status(verified ? 200 : 400).json({
      success: verified,
      ...msg91Response,
    });
  } catch (error) {
    return handleOtpError(res, "verify OTP", error);
  }
});

router.post("/retry", async (req, res) => {
  try {
    const reqId = normalizeString(req.body.reqId || req.body.requestId);
    const retryChannel = req.body.retryChannel;

    if (!reqId) {
      return res.status(400).json({ success: false, message: "reqId is required." });
    }

    const body = { reqId };
    if (retryChannel !== undefined && retryChannel !== null && retryChannel !== "") {
      body.retryChannel = retryChannel;
    }

    const msg91Response = await callMsg91Widget("/retryOtp", body);

    return res.status(200).json({
      success: isMsg91Success(msg91Response),
      ...msg91Response,
    });
  } catch (error) {
    return handleOtpError(res, "retry OTP", error);
  }
});

async function callMsg91Widget(endpoint, body) {
  const widgetId = process.env.MSG91_WIDGET_ID;
  const tokenAuth = process.env.MSG91_WIDGET_TOKEN_AUTH;

  if (!widgetId || !tokenAuth) {
    throw new Error(
      "MSG91_WIDGET_ID and MSG91_WIDGET_TOKEN_AUTH must be configured.",
    );
  }

  const response = await axios.post(
    `${MSG91_WIDGET_BASE_URL}${endpoint}`,
    {
      widgetId,
      tokenAuth,
      ...body,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

  return response.data || {};
}

function normalizeIdentifier(value) {
  const normalized = normalizeString(value);
  if (normalized.startsWith("+")) {
    return normalized.slice(1);
  }
  return normalized;
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function validateIdentifier(identifier) {
  if (!identifier) {
    return "identifier is required.";
  }
  if (!/^[0-9]{7,15}$/.test(identifier)) {
    return "identifier must contain 7 to 15 digits with country code and without +.";
  }
  return null;
}

function validateVerifyOtp({ reqId, otp }) {
  if (!reqId) {
    return "reqId is required.";
  }
  if (!otp) {
    return "otp is required.";
  }
  if (!/^[0-9]{4,9}$/.test(otp)) {
    return "otp must contain 4 to 9 digits.";
  }
  return null;
}

function isMsg91Success(data) {
  return data && (data.type === "success" || data.success === true);
}

function handleOtpError(res, action, error) {
  const msg91Data = error.response && error.response.data;
  const message = msg91Data && msg91Data.message
    ? msg91Data.message
    : error.message;

  console.error(`Error in ${action}:`, message);
  return res.status(400).json({
    success: false,
    message,
    msg91Data,
  });
}

module.exports = router;
