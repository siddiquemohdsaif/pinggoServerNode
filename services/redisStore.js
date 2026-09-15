const { getRedis } = require("./redisClient");

async function getJson(key) {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (_error) { return null; }
}

async function setJson(key, value, ttlSeconds) {
  const redis = await getRedis();
  if (!redis) return false;
  try {
    await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
    return true;
  } catch (_error) { return false; }
}

async function remove(key) {
  const redis = await getRedis();
  if (!redis) return false;
  try { await redis.del(key); return true; } catch (_error) { return false; }
}

async function allowRate(key, limit, windowSeconds) {
  const redis = await getRedis();
  if (!redis) return { allowed: true, remaining: null, retryAfterSeconds: null };
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  const ttl = await redis.ttl(key);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, ttl) };
}

module.exports = { getJson, setJson, remove, allowRate };
