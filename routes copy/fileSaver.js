// -----------------------------------------------------------------------------
// routes/fileSaver.js (Express Router)
// -----------------------------------------------------------------------------
// Mount this router at:   app.use("/fileSaver", require("./routes/fileSaver"));
// Endpoints:
//   POST /set   – body: multipart/form‑data field "file"; query: fileName, validity
//   GET  /get   – query: fileName
// -----------------------------------------------------------------------------


/*  examples:
//upload from ubuntu using curl
curl -F "file=@45.png" \
     "https://function.cloudsw3.com/cc-app-api_dev/fileSaver/set?fileName=45.png&validity=$(($(date +%s%3N)+604800000))"


//download
https://function.cloudsw3.com/cc-app-api_dev/fileSaver/get?fileName=45.png
*/




const express = require("express");
const multer  = require("multer");
const mime    = require("mime-types");
const FileServiceUtil = require("../utils/FileServiceUtil");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// --------------------------- POST /set ---------------------------------------
router.post("/set", upload.single("file"), async (req, res) => {
  try {
    const { file } = req;
    const { fileName, validity } = req.query;

    if (!file) {
      return res.status(400).json({ error: "multipart field 'file' missing" });
    }
    if (!fileName) {
      return res.status(400).json({ error: "fileName query param required" });
    }
    if (!validity) {
      return res.status(400).json({ error: "validity query param required" });
    }

    const expiry = Number(validity);
    if (Number.isNaN(expiry)) {
      return res.status(400).json({ error: "validity must be epoch‑ms number" });
    }

    const result = await FileServiceUtil.saveFile(file.buffer, fileName, expiry);
    res.json({ message: "File stored", ...result });
  } catch (err) {
    console.error("/set error", err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------- GET /get ---------------------------------------
router.get("/get", async (req, res) => {
  try {
    const { fileName } = req.query;
    if (!fileName) {
      return res.status(400).json({ error: "fileName query param required" });
    }

    if (await FileServiceUtil.isExpired(fileName)) {
      return res.status(410).json({ error: "File expired" });
    }

    const filePath = await FileServiceUtil.getFilePath(fileName);
    if (!filePath) {
      return res.status(404).json({ error: "File not found" });
    }

    res.setHeader(
      "Content-Type",
      mime.lookup(fileName) || "application/octet-stream"
    );
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
    );

    FileServiceUtil.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("/get error", err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Start hourly cleanup when this module is first imported
// -----------------------------------------------------------------------------
FileServiceUtil.cleanupExpired();
setInterval(FileServiceUtil.cleanupExpired, 60 * 60 * 1000);

module.exports = router;
