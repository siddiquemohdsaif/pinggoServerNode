const { createClient } = require("redis");

let client;
let connecting;
let warned = false;

async function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL,
      socket: { connectTimeout: 2000, reconnectStrategy: (retries) =>
        Math.min(250 * 2 ** Math.min(retries, 5), 5000) } });
    client.on("error", (error) => {
      if (!warned) console.warn(`[redis] unavailable: ${error.message}`);
      warned = true;
    });
  }
  if (client.isReady) return client;
  if (!connecting) connecting = client.connect().catch(() => null).finally(() => {
    connecting = null;
  });
  await connecting;
  if (client.isReady) { warned = false; return client; }
  return null;
}

async function closeRedis() {
  if (client && client.isOpen) await client.quit().catch(() => client.destroy());
}

module.exports = { getRedis, closeRedis };
