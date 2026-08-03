const express = require("express");
const path = require("path");
const AES = require("./utils/AES_256");
const app = express();
require("dotenv").config();
const fs = require("fs").promises;

let port;
if (process.env.PRODUCTION_TYPE === "release") {
  port = 4100;
} else {
  port = 4100 + 100;
}

// Import routes
const healthCheck = require("./routes/healthCheck");
const login = require("./routes/login");
const signup = require("./routes/signup");
const uploadProfilePhoto = require("./routes/uploadProfilePhoto");
const updateName = require("./routes/updateName");
const updateDescription = require("./routes/updateDescription");

// app.use(express.json());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Use routes without authorization
app.use("/healthCheck", healthCheck);
app.use("/login", login);
app.use("/signup", signup);

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

authorizedRoutes.use("/uploadProfilePhoto", uploadProfilePhoto);
authorizedRoutes.use("/updateName", updateName);
authorizedRoutes.use("/updateDescription", updateDescription);
// authorizedRoutes.use('/changeAvatar', changeAvatar);

app.use("/", authorizedRoutes); // Use the grouped routes

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
