// const express = require('express');
// const multer = require('multer');
// const AES = require("../utils/AES_256");

// const router = express.Router();
// const securityKey = "123456";

// // In-memory file storage
// const storage = multer.memoryStorage();
// const upload = multer({ storage: storage });

// router.post('/', upload.single('audio'), async (req, res) => {
//     try {
//         const uid = req.body.UID;
//         const audioBinary = req.file?.buffer;

//         if (!uid || !audioBinary) {
//             return res.status(400).json({ success: false, message: 'UID and Audio are required.' });
//         }

//         // Authorization check
//         if (uid !== AES.getAuthUid(req)) {
//             return res.status(401).json({ success: false, message: 'Authorization failed' });
//         }

//         const fileName = `${Date.now()}_${uid}.mp3`;
//         const datenow = new Date();
//         const validity = new Date(datenow.getTime() + 7 * 24 * 60 * 60 * 1000);

//         let url = "" ;// get from fileSaver call after uploading file



//         return res.status(200).json({
//             success: true,
//             url: url,
//         });

//     } catch (error) {
//         console.error("Error in voiceMessage:", error.message);
//         return res.status(500).json({ success: false, message: error.message });
//     }
// });

// module.exports = router;













// routes/voiceMessage.js
// -----------------------------------------------------------------------------
// decides the file-saver sub-path automatically from .env  ->  PRODUCTION_TYPE
//   dev  →  cc-app-api_dev
//   prod →  cc-app-api            (any value other than “dev” is treated as prod)
// -----------------------------------------------------------------------------

const express  = require("express");
const multer   = require("multer");
const AES      = require("../utils/AES_256");
const axios    = require("axios");
const FormData = require("form-data");

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage() });

// ──────────────────────────────────────────────────────────────────────────────
// Resolve base URL once, using PRODUCTION_TYPE from .env
// ──────────────────────────────────────────────────────────────────────────────
const PRODUCTION_TYPE = (process.env.PRODUCTION_TYPE || "prod").trim().toLowerCase();
const SUB_PATH        = PRODUCTION_TYPE === "dev" ? "cc-app-api_dev" : "cc-app-api";
const FILE_SAVER_BASE = `https://function.cloudsw3.com/${SUB_PATH}/fileSaver`;

// -----------------------------------------------------------------------------
// POST /voiceMessage
// -----------------------------------------------------------------------------
router.post("/", upload.single("audio"), async (req, res) => {
  try {
    const uid         = req.body.UID;
    const audioBinary = req.file?.buffer;

    if (!uid || !audioBinary) {
      return res.status(400).json({ success: false, message: "UID and audio are required." });
    }
    if (uid !== AES.getAuthUid(req)) {
      return res.status(401).json({ success: false, message: "Authorization failed." });
    }

    // ── build filename + validity (+7 days) ──────────────────────────────────
    const fileName   = `${Date.now()}_${uid}.mp3`;
    const validityMs = Date.now() + 7 * 24 * 60 * 60 * 1000;

    // ── upload to /set ───────────────────────────────────────────────────────
    const form = new FormData();
    form.append("file", audioBinary, { filename: fileName, contentType: "audio/mpeg" });

    await axios.post(
      `${FILE_SAVER_BASE}/set?fileName=${encodeURIComponent(fileName)}&validity=${validityMs}`,
      form,
      { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
    );

    // ── final public URL ─────────────────────────────────────────────────────
    const url = `${FILE_SAVER_BASE}/get?fileName=${encodeURIComponent(fileName)}`;

    res.json({ success: true, url });
  } catch (err) {
    console.error("Error in voiceMessage:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
