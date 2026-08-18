const express = require("express");
const http = require("http");
const path = require("path");
const AES = require("./utils/AES_256");
const { createWebSocketServer } = require("./realtime/websocketServer");
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
const auth = require("./routes/auth");

// app.use(express.json());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "..", "PinggoServerNode", "public")));

// Use routes without authorization
app.use("/healthCheck", healthCheck);
app.use("/checkUserExists", checkUserExists);
app.use("/login", login);
app.use("/otp", otp);
app.use("/signup", signup);
app.use("/auth", auth);

// Authorization middleware
const authMiddleware = (req, res, next) => {
  if (!AES.validateEncryptedCredentialByHeader(req)) {
    return res
      .status(401)
      .json({ success: false, message: "Authorization failed" });
  }
  next();
};

// Grouped routes that require authorization
const authorizedRoutes = express.Router();
authorizedRoutes.use(authMiddleware); // Apply the middleware
authorizedRoutes.use("/profile", profile);
authorizedRoutes.use("/chats", chats);

app.use("/", authorizedRoutes); // Use the grouped routes

const server = http.createServer(app);
createWebSocketServer(server);

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
