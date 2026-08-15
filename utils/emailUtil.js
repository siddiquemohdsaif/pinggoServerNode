const crypto = require("crypto");
const nodemailer = require("nodemailer");
const FirestoreManager = require("../Firestore/FirestoreManager");

require("dotenv").config();

const firestoreManager = FirestoreManager.getInstance();
const EMAIL_OTP_COLLECTION = "EmailOtp";
const OTP_EXPIRY_MS = 5 * 60 * 1000;

class EmailUtil {
  static async emailSend(req, res) {
    try {
      const email = this.normalizeEmail(req.body.email || req.body.Email);
      const validationError = this.validateEmail(email);
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      const otpDocument = this.createOtpDocumentData(email);
      await this.createOtpDocument(email, otpDocument);

      try {
        await this.sendOtpEmail(email, otpDocument.Code);
      } catch (error) {
        await this.deleteOtpDocumentQuietly(email);
        throw error;
      }

      return res.status(200).json(this.buildSendResponse(email, false));
    } catch (error) {
      return this.handleEmailError(res, "send email", error);
    }
  }

  static async emailVerify(req, res) {
    try {
      const email = this.normalizeEmail(req.body.email || req.body.Email);
      const code = this.normalizeString(req.body.code || req.body.Code || req.body.otp);
      const validationError = this.validateVerificationInput(email, code);
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      const otpDocument = await this.readOtpDocument(email);
      if (!otpDocument) {
        return res.status(400).json({
          success: false,
          message: "No email verification code was found. Request a new code.",
        });
      }

      if (this.isExpired(otpDocument)) {
        await this.deleteOtpDocumentQuietly(email);
        return res.status(400).json({
          success: false,
          message: "Email verification code has expired. Request a new code.",
        });
      }

      if (!this.codesMatch(code, otpDocument.Code)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email verification code.",
        });
      }

      await this.deleteOtpDocument(email);
      return res.status(200).json({
        success: true,
        email,
        message: "Email verified successfully.",
      });
    } catch (error) {
      return this.handleEmailError(res, "verify email", error);
    }
  }

  static async emailResend(req, res) {
    try {
      const email = this.normalizeEmail(req.body.email || req.body.Email);
      const validationError = this.validateEmail(email);
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      const previousDocument = await this.readOtpDocument(email);
      const otpDocument = this.createOtpDocumentData(email);
      if (previousDocument) {
        await this.updateOtpDocument(email, otpDocument);
      } else {
        await this.createOtpDocument(email, otpDocument);
      }

      try {
        await this.sendOtpEmail(email, otpDocument.Code);
      } catch (error) {
        if (previousDocument) {
          await this.restoreOtpDocumentQuietly(email, previousDocument);
        } else {
          await this.deleteOtpDocumentQuietly(email);
        }
        throw error;
      }

      return res.status(200).json(this.buildSendResponse(email, true));
    } catch (error) {
      return this.handleEmailError(res, "resend email", error);
    }
  }

  static createOtpDocumentData(email, now = Date.now()) {
    return {
      Email: email,
      Code: this.generateOtp(),
      Timestamp: now,
      ExpireTimestamp: now + OTP_EXPIRY_MS,
    };
  }

  static generateOtp() {
    return crypto.randomInt(100000, 1000000).toString();
  }

  static getDocumentId(email) {
    return email.replace(/\./g, "<dot>");
  }

  static async createOtpDocument(email, document) {
    return firestoreManager.createDocument(
      EMAIL_OTP_COLLECTION,
      this.getDocumentId(email),
      "/",
      document,
    );
  }

  static async readOtpDocument(email) {
    try {
      return await firestoreManager.readDocument(
        EMAIL_OTP_COLLECTION,
        this.getDocumentId(email),
        "/",
      );
    } catch (error) {
      if (String(error.message).includes("404")) {
        return null;
      }
      throw error;
    }
  }

  static async updateOtpDocument(email, document) {
    return firestoreManager.updateDocument(
      EMAIL_OTP_COLLECTION,
      this.getDocumentId(email),
      "/",
      document,
    );
  }

  static async deleteOtpDocument(email) {
    return firestoreManager.deleteDocument(
      EMAIL_OTP_COLLECTION,
      this.getDocumentId(email),
      "/",
    );
  }

  static async deleteOtpDocumentQuietly(email) {
    try {
      await this.deleteOtpDocument(email);
    } catch (error) {
      console.error("Failed to clean up email OTP:", error.message);
    }
  }

  static async restoreOtpDocumentQuietly(email, previousDocument) {
    try {
      const document = { ...previousDocument };
      delete document._id;
      await this.updateOtpDocument(email, document);
    } catch (error) {
      console.error("Failed to restore previous email OTP:", error.message);
    }
  }

  static async sendOtpEmail(email, code) {
    const senderEmail = this.normalizeString(process.env.EMAIL || process.env.EMAIL_USER);
    const appPassword = this.normalizeString(
      process.env.EMAIL_APP_PASSWORD || process.env.EMAIL_PASSWORD,
    );

    if (!senderEmail || !appPassword) {
      throw new Error("EMAIL and EMAIL_APP_PASSWORD must be configured.");
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: senderEmail,
        pass: appPassword,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || `Pinggo <${senderEmail}>`,
      to: email,
      subject: "Your Pinggo verification code",
      text: `Your Pinggo verification code is ${code}. It expires in 5 minutes.`,
      html: `<p>Your Pinggo verification code is <strong>${code}</strong>.</p><p>It expires in 5 minutes.</p>`,
    });
  }

  static buildSendResponse(email, resent) {
    return {
      success: true,
      email,
      expiresInSeconds: OTP_EXPIRY_MS / 1000,
      message: resent
        ? "Email verification code resent successfully."
        : "Email verification code sent successfully.",
    };
  }

  static normalizeEmail(value) {
    return this.normalizeString(value).toLowerCase();
  }

  static normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  static validateEmail(email) {
    if (!email) {
      return "email is required.";
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return "email must be a valid email address.";
    }
    if (email.includes("/") || email.includes("`")) {
      return "email contains unsupported characters.";
    }
    return null;
  }

  static validateVerificationInput(email, code) {
    const emailError = this.validateEmail(email);
    if (emailError) {
      return emailError;
    }
    if (!code) {
      return "code is required.";
    }
    if (!/^\d{6}$/.test(code)) {
      return "code must contain exactly 6 digits.";
    }
    return null;
  }

  static isExpired(document, now = Date.now()) {
    const expireTimestamp = Number(document.ExpireTimestamp);
    return !Number.isFinite(expireTimestamp) || now >= expireTimestamp;
  }

  static codesMatch(receivedCode, storedCode) {
    const received = Buffer.from(this.normalizeString(receivedCode));
    const stored = Buffer.from(this.normalizeString(storedCode));
    return received.length === stored.length && crypto.timingSafeEqual(received, stored);
  }

  static handleEmailError(res, action, error) {
    console.error(`Error in ${action}:`, error.message);
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
}

module.exports = EmailUtil;
