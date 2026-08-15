const { OAuth2Client } = require("google-auth-library");


const GOOGLE_WEB_CLIENT_ID =
  process.env.GOOGLE_WEB_CLIENT_ID;
const oauthClient = new OAuth2Client(GOOGLE_WEB_CLIENT_ID);

class GoogleAuthUtil {
  static async verify(req, res) {
    const idToken = this.normalizeToken(req.body && req.body.idToken);
    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: "Google ID token is required.",
      });
    }

    if (idToken.length > 16384) {
      return res.status(400).json({
        success: false,
        message: "Google ID token is invalid.",
      });
    }

    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken,
        audience: GOOGLE_WEB_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
        return res.status(401).json({
          success: false,
          message: "Google did not return a verified email address.",
        });
      }

      return res.status(200).json({
        success: true,
        email: payload.email.trim().toLowerCase(),
        googleSubject: payload.sub,
        message: "Google account verified successfully.",
      });
    } catch (error) {
      console.error("Google ID token verification failed:", error.message);
      return res.status(401).json({
        success: false,
        message: "Google authentication failed.",
      });
    }
  }

  static normalizeToken(value) {
    return typeof value === "string" ? value.trim() : "";
  }
}

module.exports = GoogleAuthUtil;
