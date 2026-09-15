const crypto = require("crypto");
const { allowRate } = require("./redisStore");

function rateLimit({ namespace, limit, windowSeconds, identity }) {
  return async (req, res, next) => {
    try {
      const raw = identity(req) || req.ip || "unknown";
      const digest = crypto.createHash("sha256").update(String(raw)).digest("hex");
      const result = await allowRate(`pinggo:rate:${namespace}:${digest}`, limit, windowSeconds);
      if (result.remaining != null) res.set("X-RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) {
        res.set("Retry-After", String(result.retryAfterSeconds));
        return res.status(429).json({ success: false,
          message: "Too many requests. Retry later." });
      }
      return next();
    } catch (_error) {
      return next();
    }
  };
}

module.exports = { rateLimit };
