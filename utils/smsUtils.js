const axios = require("axios");

const MSG91_WIDGET_BASE_URL = "https://control.msg91.com/api/v5/widget";
const DEXATEL_VERIFY_BASE_URL = "https://api.dexatel.com/v1/verifications";

const SMS_PROVIDERS = {
  MSG91: "msg91",
  DEXATEL: "dexatel",
};

class SmsUtils {
  static async smsSend(req, res) {
    try {
      const identifier = this.normalizeIdentifier(
        req.body.identifier || req.body.mobile || req.body.phoneNumber || req.body.phone,
      );

      const validationError = this.validateIdentifier(identifier);
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      const provider = this.getRequestedProvider(req.body.provider)
        || this.getSmsProviderForIdentifier(identifier);
      if (provider === SMS_PROVIDERS.DEXATEL) {
        const dexatelResponse = await this.sendDexatelSms(identifier);
        return res.status(200).json(
          this.buildDexatelSendResponse(identifier, provider, dexatelResponse),
        );
      }

      const msg91Response = await this.callMsg91Widget("/sendOtpMobile", { identifier });
      return res.status(200).json(this.buildMsg91SendResponse(provider, msg91Response));
    } catch (error) {
      return this.handleSmsError(res, "send SMS", error);
    }
  }

  static async smsVerify(req, res) {
    try {
      const reqId = this.normalizeString(req.body.reqId || req.body.requestId);
      const identifier = this.normalizeIdentifier(
        req.body.identifier || req.body.mobile || req.body.phoneNumber || req.body.phone,
      );
      const verifyIdentifier = identifier || this.normalizeIdentifier(reqId);
      const otp = this.normalizeString(req.body.otp);
      const provider = this.getRequestedProvider(req.body.provider)
        || this.getSmsProviderForVerify({ identifier, reqId });

      const validationError = provider === SMS_PROVIDERS.DEXATEL
        ? this.validateDexatelVerifySms({ identifier: verifyIdentifier, otp })
        : this.validateVerifySms({ reqId, otp });
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      if (provider === SMS_PROVIDERS.DEXATEL) {
        const dexatelResponse = await this.verifyDexatelSms(verifyIdentifier, otp);
        const verified = this.isDexatelVerifySuccess(dexatelResponse);
        return res
          .status(verified ? 200 : 400)
          .json(
            this.buildDexatelVerifyResponse(
              verifyIdentifier,
              provider,
              verified,
              dexatelResponse,
            ),
          );
      }

      const msg91Response = await this.callMsg91Widget("/verifyOtp", { reqId, otp });
      const verified = this.isMsg91Success(msg91Response);
      return res
        .status(verified ? 200 : 400)
        .json(this.buildMsg91VerifyResponse(reqId, provider, verified, msg91Response));
    } catch (error) {
      return this.handleSmsError(res, "verify SMS", error);
    }
  }

  static async smsResend(req, res) {
    try {
      const reqId = this.normalizeString(req.body.reqId || req.body.requestId);
      const identifier = this.normalizeIdentifier(
        req.body.identifier || req.body.mobile || req.body.phoneNumber || req.body.phone,
      );
      const retryChannel = req.body.retryChannel;
      const provider = this.getRequestedProvider(req.body.provider)
        || this.getSmsProviderForVerify({ identifier, reqId });

      if (provider === SMS_PROVIDERS.DEXATEL) {
        const phone = identifier || this.normalizeIdentifier(reqId);
        const validationError = this.validateIdentifier(phone);
        if (validationError) {
          return res.status(400).json({ success: false, message: validationError });
        }

        const dexatelResponse = await this.sendDexatelSms(phone);
        return res.status(200).json(
          this.buildDexatelSendResponse(phone, provider, dexatelResponse),
        );
      }

      if (!reqId) {
        return res.status(400).json({ success: false, message: "reqId is required." });
      }

      const body = { reqId };
      if (retryChannel !== undefined && retryChannel !== null && retryChannel !== "") {
        body.retryChannel = retryChannel;
      }

      const msg91Response = await this.callMsg91Widget("/retryOtp", body);
      return res.status(200).json(this.buildMsg91SendResponse(provider, msg91Response));
    } catch (error) {
      return this.handleSmsError(res, "resend SMS", error);
    }
  }

  static getSmsProviderForIdentifier(identifier) {
    return identifier.startsWith("91") ? SMS_PROVIDERS.MSG91 : SMS_PROVIDERS.DEXATEL;
  }

  static getSmsProviderForVerify({ identifier, reqId }) {
    if (identifier) {
      return this.getSmsProviderForIdentifier(identifier);
    }

    const normalizedReqId = this.normalizeIdentifier(reqId);
    if (/^[0-9]{7,15}$/.test(normalizedReqId)) {
      return this.getSmsProviderForIdentifier(normalizedReqId);
    }

    return SMS_PROVIDERS.MSG91;
  }

  static getRequestedProvider(value) {
    const provider = this.normalizeString(value).toLowerCase();
    if (!provider) {
      return null;
    }
    if (!Object.values(SMS_PROVIDERS).includes(provider)) {
      throw new Error("provider must be msg91 or dexatel.");
    }
    return provider;
  }

  static async callMsg91Widget(endpoint, body) {
    const widgetId = process.env.MSG91_WIDGET_ID;
    const tokenAuth = process.env.MSG91_WIDGET_TOKEN_AUTH;

    if (!widgetId || !tokenAuth) {
      throw new Error("MSG91_WIDGET_ID and MSG91_WIDGET_TOKEN_AUTH must be configured.");
    }

    const response = await axios.post(
      `${MSG91_WIDGET_BASE_URL}${endpoint}`,
      { widgetId, tokenAuth, ...body },
      { headers: { "Content-Type": "application/json" } },
    );

    return response.data || {};
  }

  static async sendDexatelSms(phone) {
    const apiKey = process.env.DEXATEL_API_KEY;
    const sender = this.normalizeString(process.env.DEXATEL_SENDER);
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

    const response = await axios.post(
      DEXATEL_VERIFY_BASE_URL,
      {
        data: {
          channel: "sms",
          sender,
          phone,
          template,
          code_length: codeLength,
        },
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

  static async verifyDexatelSms(phone, otp) {
    const apiKey = process.env.DEXATEL_API_KEY;
    if (!apiKey) {
      throw new Error("DEXATEL_API_KEY must be configured.");
    }

    const response = await axios.get(DEXATEL_VERIFY_BASE_URL, {
      headers: { "X-Dexatel-Key": apiKey },
      params: { code: otp, phone },
    });

    return response.data || {};
  }

  static normalizeIdentifier(value) {
    const normalized = this.normalizeString(value);
    return normalized.startsWith("+") ? normalized.slice(1) : normalized;
  }

  static normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  static validateIdentifier(identifier) {
    if (!identifier) {
      return "identifier is required.";
    }
    if (!/^[0-9]{7,15}$/.test(identifier)) {
      return "identifier must contain 7 to 15 digits with country code and without +.";
    }
    return null;
  }

  static validateVerifySms({ reqId, otp }) {
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

  static validateDexatelVerifySms({ identifier, otp }) {
    const identifierError = this.validateIdentifier(identifier);
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

  static isMsg91Success(data) {
    return data && (data.type === "success" || data.success === true);
  }

  static isDexatelVerifySuccess(data) {
    if (Array.isArray(data)) {
      return data.length > 0;
    }
    if (data && Array.isArray(data.data)) {
      return data.data.length > 0;
    }
    return Boolean(data && (data.success === true || data.message_id || data.id));
  }

  static buildMsg91SendResponse(provider, data) {
    const success = this.isMsg91Success(data);
    const reqId = this.normalizeString(data.message);
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

  static buildMsg91VerifyResponse(reqId, provider, verified, data) {
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

  static buildDexatelSendResponse(phone, provider, data) {
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

  static buildDexatelVerifyResponse(phone, provider, verified, data) {
    const verification = this.getFirstDexatelVerification(data);
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

  static getFirstDexatelVerification(data) {
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

  static handleSmsError(res, action, error) {
    const providerData = error.response && error.response.data;
    const message = providerData && providerData.message
      ? providerData.message
      : error.message;

    console.error(`Error in ${action}:`, message);
    return res.status(400).json({ success: false, message, providerData });
  }
}

module.exports = SmsUtils;
