const express = require("express");
const http = require("http");
const AES = require("./utils/AES_256");
const { createWebSocketServer } = require("./realtime/websocketServer");
const { createMediaWebSocketServer } = require("./realtime/mediaServer");
const app = express();
require("dotenv").config();

let port;
if (process.env.PRODUCTION_TYPE === "release") {
  port = 4100;
} else {
  port = 4100 + 100;
}

// Import routes
const healthCheck = require("./routes/healthCheck");
const checkUserExists = require("./routes/checkUserExists");
const login = require("./routes/login");
const otp = require("./routes/otp");
const profile = require("./routes/profile");
const signup = require("./routes/signup");
const chats = require("./routes/chats.js");
const calls = require("./routes/calls.js");
const auth = require("./routes/auth");
const files = require("./routes/files");
const chatAttachments = require("./routes/chatAttachments");
const groups = require("./routes/groups");
const devices = require("./routes/devices");
const account = require("./routes/account");
const deviceLinks = require("./routes/deviceLinks");
const { maxFileSizeMb, uploadDir } = require("./utils/fileStorage");
const { isDeviceRevoked } = require("./models/DeviceStore");
const { isAccountDeleted, isCurrentPrimaryCredential } =
  require("./services/accountDeletionService");
const metrics = require("./services/performanceMetrics");
const { getOnlineUserCount, getOnlineDeviceCount } = require("./realtime/connectionManager");
const retryQueue = require("./services/retryQueue");
const { closeRedis } = require("./services/redisClient");
const { sendOfflineMessageNotification } = require("./realtime/fcmService");

// app.use(express.json());
app.use(metrics.httpMiddleware);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));
app.use("/files", express.static(uploadDir));

app.get("/internal/metrics", (req, res) => {
  const expected = process.env.METRICS_TOKEN;
  if (!expected && process.env.PRODUCTION_TYPE === "release") {
    return res.status(503).json({ success: false, message: "Metrics token is not configured." });
  }
  if (expected && req.get("authorization") !== `Bearer ${expected}`) {
    return res.status(401).json({ success: false, message: "Metrics authorization failed." });
  }
  return res.json(metrics.snapshot({ onlineUsers: getOnlineUserCount(),
    onlineDevices: getOnlineDeviceCount() }));
});

// Use routes without authorization
app.use("/healthCheck", healthCheck);
app.use("/checkUserExists", checkUserExists);
app.use("/login", login);
app.use("/otp", otp);
app.use("/signup", signup);
app.use("/auth", auth);
app.use("/device-links", deviceLinks);
app.use(files);

// Authorization middleware
const authMiddleware = async (req, res, next) => {
  const claims = AES.getHeaderCredentialClaims(req);
  if (!claims) {
    return res
      .status(401)
      .json({ success: false, message: "Authorization failed" });
  }
  if (await isAccountDeleted(claims.uid)) {
    return res.status(401).json({ success: false, message: "This account has been deleted." });
  }
  if (!claims.deviceId && !await isCurrentPrimaryCredential(claims.uid, claims.context)) {
    return res.status(401).json({ success: false, message: "This session is no longer valid." });
  }
  if (claims.deviceId && await isDeviceRevoked(claims.uid, claims.deviceId)) {
    return res.status(401).json({ success: false, message: "This linked device has been logged out." });
  }
  req.auth = { userId: claims.uid, deviceId: claims.deviceId || null };
  next();
};

// Grouped routes that require authorization
const authorizedRoutes = express.Router();
authorizedRoutes.use(authMiddleware); // Apply the middleware
authorizedRoutes.use("/profile", profile);
authorizedRoutes.use("/chats/attachments", chatAttachments);
authorizedRoutes.use("/chats", chats);
authorizedRoutes.use("/calls", calls);
authorizedRoutes.use("/groups", groups);
authorizedRoutes.use("/devices", devices);
authorizedRoutes.use("/account", account);

app.use("/", authorizedRoutes); // Use the grouped routes

app.use((error, _req, res, _next) => {
  if (error instanceof require("multer").MulterError) {
    return res.status(400).json({ success: false, message: error.message });
  }
  console.error(error);
  return res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : "Internal server error.",
  });
});

const server = http.createServer(app);
retryQueue.register("offline-message-notification", sendOfflineMessageNotification);
retryQueue.start();
const signalingWebSocketServer = createWebSocketServer();
const mediaWebSocketServer = createMediaWebSocketServer();

server.on("upgrade", (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch (_error) {
    socket.destroy();
    return;
  }

  const selectedServer = pathname === "/ws"
    ? signalingWebSocketServer
    : pathname === "/media"
      ? mediaWebSocketServer
      : null;

  console.log(`[ws-upgrade] path=${pathname} accepted=${Boolean(selectedServer)} time=${Date.now()}`);

  if (!selectedServer) {
    socket.destroy();
    return;
  }

  selectedServer.handleUpgrade(request, socket, head, (webSocket) => {
    selectedServer.emit("connection", webSocket, request);
  });
});

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log(`Uploads are stored in ${uploadDir}`);
});

async function shutdown() {
  retryQueue.stop();
  server.close(async () => {
    await closeRedis();
    process.exit(0);
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
