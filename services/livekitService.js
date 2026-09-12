const { AccessToken, TrackSource } = require("livekit-server-sdk");

function isLiveKitConfigured() {
  return missingLiveKitVariables().length === 0;
}

function missingLiveKitVariables() {
  return ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]
    .filter((name) => !String(process.env[name] || "").trim());
}

async function createParticipantToken({ roomName, userId, mediaType }) {
  if (!isLiveKitConfigured()) {
    const error = new Error("LiveKit is not configured.");
    error.statusCode = 503;
    throw error;
  }
  if (!roomName || !userId) {
    const error = new Error("roomName and userId are required.");
    error.statusCode = 400;
    throw error;
  }
  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: userId, ttl: "15m" },
  );
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: mediaType === "video"
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
      : [TrackSource.MICROPHONE],
  });
  return token.toJwt();
}

module.exports = { createParticipantToken, isLiveKitConfigured, missingLiveKitVariables };
