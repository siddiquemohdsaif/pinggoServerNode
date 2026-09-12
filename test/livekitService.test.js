const test = require("node:test");
const assert = require("node:assert/strict");
const { createParticipantToken, isLiveKitConfigured } = require("../services/livekitService");

test("LiveKit stays unavailable without server credentials", () => {
  const previous = [process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET];
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  assert.equal(isLiveKitConfigured(), false);
  [process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET] = previous;
});

test("LiveKit creates a signed, room-scoped participant token", async () => {
  const previous = [process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET];
  process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "test-key";
  process.env.LIVEKIT_API_SECRET = "test-secret-that-is-long-enough";
  const token = await createParticipantToken({
    roomName: "pinggo_call_1", userId: "user_1", mediaType: "video",
  });
  assert.equal(token.split(".").length, 3);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(payload.sub, "user_1");
  assert.equal(payload.video.room, "pinggo_call_1");
  assert.deepEqual(payload.video.canPublishSources, ["microphone", "camera"]);
  [process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET] = previous;
});
