const express = require("express");
const axios = require("axios");

const router = express.Router();

const MSG91_WIDGET_BASE_URL = "https://control.msg91.com/api/v5/widget";
const DEXATEL_VERIFY_BASE_URL = "https://api.dexatel.com/v1/verifications";

const OTP_PROVIDERS = {
  MSG91: "msg91",
  DEXATEL: "dexatel",
};

router.post("/send", async (req, res) => {
  try {
    const identifier = normalizeIdentifier(
      req.body.identifier || req.body.mobile || req.body.phoneNumber || req.body.phone,
    );

    const validationError = validateIdentifier(identifier);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const provider = getRequestedProvider(req.body.provider) || getOtpProviderForIdentifier(identifier);
    if (provider === OTP_PROVIDERS.DEXATEL) {
      const dexatelResponse = await sendDexatelOtp(identifier);
      return res.status(200).json(buildDexatelSendResponse(identifier, provider, dexatelResponse));
    }

    const msg91Response = await callMsg91Widget("/sendOtpMobile", { identifier });
    return res.status(200).json(buildMsg91SendResponse(provider, msg91Response));
  } catch (error) {
    return handleOtpError(res, "send OTP", error);
  }
});

router.post("/verify", async (req, res) => {
  try {
    const reqId = normalizeString(req.body.reqId || req.body.requestId);
    const identifier = normalizeIdentifier(
      req.body.identifier || req.body.mobile || req.body.phoneNumber || req.body.phone,
    );
    const verifyIdentifier = identifier || normalizeIdentifier(reqId);
    const otp = normalizeString(req.body.otp);
    const provider = getRequestedProvider(req.body.provider)
      || getOtpProviderForVerify({ identifier, reqId });

    const validationError = provider === OTP_PROVIDERS.DEXATEL
      ? validateDexatelVerifyOtp({ identifier: verifyIdentifier, otp })
      : validateVerifyOtp({ reqId, otp });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (provider === OTP_PROVIDERS.DEXATEL) {
      const dexatelResponse = await verifyDexatelOtp(verifyIdentifier, otp);
      const verified = isDexatelVerifySuccess(dexatelResponse);
      return res
        .status(verified ? 200 : 400)
        .json(buildDexatelVerifyResponse(verifyIdentifier, provider, verified, dexatelResponse));
    }

    const msg91Response = await callMsg91Widget("/verifyOtp", {
      reqId,
      otp,
    });

    const verified = isMsg91Success(msg91Response);
    return res
      .status(verified ? 200 : 400)
      .json(buildMsg91VerifyResponse(reqId, provider, verified, msg91Response));
  } catch (error) {
    return handleOtpError(res, "verify OTP", error);
  }
});

router.post("/retry", async (req, res) => {
  try {
    const reqId = normalizeString(req.body.reqId || req.body.requestId);
    const identifier = normalizeIdentifier(
      req.body.identifier || req.body.mobile || req.body.phoneNumber || req.body.phone,
    );
    const retryChannel = req.body.retryChannel;
    const provider = getRequestedProvider(req.body.provider)
      || getOtpProviderForVerify({ identifier, reqId });

    if (provider === OTP_PROVIDERS.DEXATEL) {
      const phone = identifier || normalizeIdentifier(reqId);
      const validationError = validateIdentifier(phone);
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      const dexatelResponse = await sendDexatelOtp(phone);
      return res.status(200).json(buildDexatelSendResponse(phone, provider, dexatelResponse));
    }

    if (!reqId) {
      return res.status(400).json({ success: false, message: "reqId is required." });
    }

    const body = { reqId };
    if (retryChannel !== undefined && retryChannel !== null && retryChannel !== "") {
      body.retryChannel = retryChannel;
    }

    const msg91Response = await callMsg91Widget("/retryOtp", body);

    return res.status(200).json(buildMsg91SendResponse(provider, msg91Response));
  } catch (error) {
    return handleOtpError(res, "retry OTP", error);
  }
});

function getOtpProviderForIdentifier(identifier) {
  if (identifier.startsWith("91")) {
    return OTP_PROVIDERS.MSG91;
  }
  return OTP_PROVIDERS.DEXATEL;
}

function getOtpProviderForVerify({ identifier, reqId }) {
  if (identifier) {
    return getOtpProviderForIdentifier(identifier);
  }

  const normalizedReqId = normalizeIdentifier(reqId);
  if (/^[0-9]{7,15}$/.test(normalizedReqId)) {
    return getOtpProviderForIdentifier(normalizedReqId);
  }

  return OTP_PROVIDERS.MSG91;
}

function getRequestedProvider(value) {
  const provider = normalizeString(value).toLowerCase();
  if (!provider) {
    return null;
  }
  if (!Object.values(OTP_PROVIDERS).includes(provider)) {
    throw new Error("provider must be msg91 or dexatel.");
  }
  return provider;
}

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

async function sendDexatelOtp(phone) {
  const apiKey = process.env.DEXATEL_API_KEY;
  const sender = normalizeString(process.env.DEXATEL_SENDER);
  const template = process.env.DEXATEL_TEMPLATE_ID;
  const codeLength = Number(process.env.DEXATEL_OTP_CODE_LENGTH || 6);

  if (!apiKey || !sender || !template) {
    throw new Error(
      "DEXATEL_API_KEY, DEXATEL_SENDER, and DEXATEL_TEMPLATE_ID must be configured.",
    );
  }
  if (!Number.isInteger(codeLength) || codeLength < 4 || codeLength > 8) {
    throw new Error("DEXATEL_OTP_CODE_LENGTH must be a number between 4 and 8.");
  }

  const data = {
    channel: "sms",
    sender,
    phone,
    template,
    code_length: codeLength,
  };

  const response = await axios.post(
    DEXATEL_VERIFY_BASE_URL,
    {
      data,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Dexatel-Key": apiKey,
      },
    },
  );

  return response.data || {};
}

async function verifyDexatelOtp(phone, otp) {
  const apiKey = process.env.DEXATEL_API_KEY;

  if (!apiKey) {
    throw new Error("DEXATEL_API_KEY must be configured.");
  }

  const response = await axios.get(DEXATEL_VERIFY_BASE_URL, {
    headers: {
      "X-Dexatel-Key": apiKey,
    },
    params: {
      code: otp,
      phone,
    },
  });

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

function validateDexatelVerifyOtp({ identifier, otp }) {
  const identifierError = validateIdentifier(identifier);
  if (identifierError) {
    return identifierError;
  }
  if (!otp) {
    return "otp is required.";
  }
  if (!/^[0-9]{4,8}$/.test(otp)) {
    return "otp must contain 4 to 8 digits.";
  }
  return null;
}

function isMsg91Success(data) {
  return data && (data.type === "success" || data.success === true);
}

function isDexatelVerifySuccess(data) {
  if (Array.isArray(data)) {
    return data.length > 0;
  }
  if (data && Array.isArray(data.data)) {
    return data.data.length > 0;
  }
  return Boolean(data && (data.success === true || data.message_id || data.id));
}

function buildMsg91SendResponse(provider, data) {
  const success = isMsg91Success(data);
  const reqId = normalizeString(data.message);
  return {
    success,
    provider,
    reqId,
    requestId: reqId,
    message: data.message,
    type: data.type,
    providerData: data,
  };
}

function buildMsg91VerifyResponse(reqId, provider, verified, data) {
  return {
    success: verified,
    provider,
    reqId,
    requestId: reqId,
    verificationToken: data.message,
    message: data.message,
    type: data.type,
    providerData: data,
  };
}

function buildDexatelSendResponse(phone, provider, data) {
  const verification = data && data.data ? data.data : data;
  return {
    success: true,
    provider,
    reqId: phone,
    requestId: phone,
    phone,
    messageId: verification && verification.message_id,
    expireDate: verification && verification.expire_date,
    data: data.data,
    providerData: data,
  };
}

function buildDexatelVerifyResponse(phone, provider, verified, data) {
  const verification = getFirstDexatelVerification(data);
  return {
    success: verified,
    provider,
    reqId: phone,
    requestId: phone,
    phone,
    messageId: verification && verification.message_id,
    expireDate: verification && verification.expire_date,
    data: data.data,
    pagination: data.pagination,
    providerData: data,
  };
}

function getFirstDexatelVerification(data) {
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  if (data && Array.isArray(data.data)) {
    return data.data[0] || null;
  }
  if (data && data.data) {
    return data.data;
  }
  return data || null;
}

function handleOtpError(res, action, error) {
  const providerData = error.response && error.response.data;
  const message = providerData && providerData.message
    ? providerData.message
    : error.message;

  console.error(`Error in ${action}:`, message);
  return res.status(400).json({
    success: false,
    message,
    providerData,
  });
}

module.exports = router;
