const { getRedis } = require("./redisClient");

const QUEUE = "pinggo:jobs:retry";
const handlers = new Map();
let timer;

function register(type, handler) { handlers.set(type, handler); }

async function enqueue(type, payload, delayMs = 1000) {
  const redis = await getRedis();
  if (!redis) return false;
  const job = { id: require("crypto").randomUUID(), type, payload,
    attempts: 0, runAt: Date.now() + delayMs };
  await redis.zAdd(QUEUE, [{ score: job.runAt, value: JSON.stringify(job) }]);
  return true;
}

async function drain() {
  const redis = await getRedis();
  if (!redis) return;
  const due = await redis.zRangeByScore(QUEUE, 0, Date.now(), { LIMIT: { offset: 0, count: 20 } });
  for (const encoded of due) {
    if (!(await redis.zRem(QUEUE, encoded))) continue;
    let job;
    try { job = JSON.parse(encoded); } catch (_error) { continue; }
    const handler = handlers.get(job.type);
    if (!handler) continue;
    try { await handler(job.payload); }
    catch (_error) {
      job.attempts += 1;
      if (job.attempts < 5) {
        job.runAt = Date.now() + Math.min(60000, 1000 * 2 ** job.attempts);
        await redis.zAdd(QUEUE, [{ score: job.runAt, value: JSON.stringify(job) }]);
      }
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => drain().catch(() => null), 1000);
  timer.unref();
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { enqueue, register, start, stop };
