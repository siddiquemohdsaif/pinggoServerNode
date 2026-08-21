const express = require("express");
const multer = require("multer");
const { deleteFile, getFile, maxFileSizeMb, saveFile } = require("../utils/fileStorage");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSizeMb * 1024 * 1024 },
});

function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const forwarded = req.headers["x-forwarded-proto"];
  const protocol = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.protocol;
  const prefix = (process.env.PUBLIC_PATH_PREFIX || "/pinggo-app-api").replace(/\/$/, "");
  return `${protocol}://${req.get("host")}${prefix}`;
}

function withDownloadUrl(req, file) {
  return { ...file, downloadUrl: `${getBaseUrl(req)}${file.publicPath}` };
}

router.post("/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Upload field 'file' is required." });
    }
    const file = await saveFile({
      buffer: req.file.buffer,
      requestedPath: req.body.path || "uploads/",
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    return res.status(201).json({ success: true, file: withDownloadUrl(req, file) });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/files", async (req, res, next) => {
  try {
    const { path: requestedPath, fileName, contentType, dataBase64, dataUrl } = req.body || {};
    const data = dataBase64 || dataUrl;
    if (!data) {
      return res.status(400).json({ success: false, message: "Field 'dataBase64' or 'dataUrl' is required." });
    }
    const match = String(data).match(/^data:([^;]+);base64,(.+)$/s);
    const file = await saveFile({
      buffer: Buffer.from(match ? match[2] : data, "base64"),
      requestedPath: requestedPath || "uploads/",
      originalName: fileName || "file",
      mimeType: contentType || (match && match[1]) || "application/octet-stream",
    });
    return res.status(201).json({ success: true, file: withDownloadUrl(req, file) });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/files", async (req, res, next) => {
  try {
    if (!req.query.path) return res.status(400).json({ success: false, message: "Query field 'path' is required." });
    const file = await getFile(req.query.path);
    if (!file) return res.status(404).json({ success: false, message: "File not found." });
    return res.json({ success: true, file: withDownloadUrl(req, { ...file, publicPath: `/files/${file.fullPath}` }) });
  } catch (error) {
    return next(error);
  }
});

router.delete("/api/files", async (req, res, next) => {
  try {
    if (!req.query.path) return res.status(400).json({ success: false, message: "Query field 'path' is required." });
    const file = await deleteFile(req.query.path);
    if (!file) return res.status(404).json({ success: false, message: "File not found." });
    return res.json({ success: true, deleted: { fullPath: file.fullPath } });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
