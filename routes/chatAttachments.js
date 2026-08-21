const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;
const AES = require("../utils/AES_256");
const FirestoreManager = require("../Firestore/FirestoreManager");
const { deleteFile, maxFileSizeMb, resolveUploadPath, saveFile, uploadDir } = require("../utils/fileStorage");

const router = express.Router();
const firestoreManager = FirestoreManager.getInstance();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSizeMb * 1024 * 1024 },
});
const KINDS = new Set(["image", "video", "file"]);
const CHUNK_SIZE = 3 * 1024 * 1024;
const MAX_FILE_BYTES = maxFileSizeMb * 1024 * 1024;
const CHUNK_SESSION_TTL_MS = Number(process.env.CHUNK_SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;
let lastChunkCleanupTime = 0;
const chunkUploadDir = path.resolve(
  process.env.CHUNK_UPLOAD_DIR || path.join(path.dirname(uploadDir), ".pinggo_chunk_uploads"),
);
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  // Multer/busboy can flag a part that lands exactly on its hard limit as
  // truncated. Allow one byte here; the route below still enforces the exact
  // expected chunk length and therefore never accepts a chunk over 3 MB.
  limits: { fileSize: CHUNK_SIZE + 1 },
});

router.post("/init", async (req, res, next) => {
  try {
    await cleanupExpiredChunkSessions();
    const uploaderId = normalizeId(AES.getAuthUid(req));
    const chatId = String(req.body.chatId || "").trim();
    const kind = String(req.body.kind || "").trim().toLowerCase();
    const fileName = String(req.body.fileName || "attachment").trim();
    const mimeType = String(req.body.mimeType || "application/octet-stream").trim();
    const totalSize = Number(req.body.totalSize);
    const totalChunks = Number(req.body.totalChunks);
    const fileHash = normalizeHash(req.body.fileHash);
    if (req.body.fileHash && !fileHash) {
      return res.status(400).json({ success: false, message: "fileHash must be a SHA-256 value." });
    }
    const error = validateChunkInit({ chatId, uploaderId, kind, mimeType, totalSize, totalChunks });
    if (error) return res.status(error.status || 400).json({ success: false, message: error.message });

    const uploadId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const sessionDir = getChunkSessionDir(uploadId);
    const manifest = {
      uploadId, attachmentId, uploaderId, chatId, kind, fileName, mimeType,
      totalSize, totalChunks, chunkSize: CHUNK_SIZE, fileHash, createdTime: Date.now(),
    };
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest));
    return res.status(201).json({ success: true, upload: manifest });
  } catch (error) {
    return next(error);
  }
});

router.get("/:uploadId/status", async (req, res, next) => {
  try {
    const manifest = await readChunkManifest(req.params.uploadId);
    const uploaderId = normalizeId(AES.getAuthUid(req));
    if (!manifest || manifest.uploaderId !== uploaderId) {
      return res.status(404).json({ success: false, message: "Upload session not found." });
    }
    const receivedChunks = [];
    for (let index = 0; index < manifest.totalChunks; index += 1) {
      try {
        const stat = await fs.stat(path.join(getChunkSessionDir(manifest.uploadId), `${index}.part`));
        const expected = index === manifest.totalChunks - 1
          ? manifest.totalSize - CHUNK_SIZE * index : CHUNK_SIZE;
        if (stat.size === expected) receivedChunks.push(index);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const completedAttachment = await readCompletedAttachment(manifest.uploadId);
    return res.json({ success: true, upload: { ...manifest, receivedChunks, completedAttachment } });
  } catch (error) {
    return next(error);
  }
});

router.post("/:uploadId/chunks/:index", chunkUpload.single("chunk"), async (req, res, next) => {
  try {
    const manifest = await readChunkManifest(req.params.uploadId);
    const uploaderId = normalizeId(AES.getAuthUid(req));
    if (!manifest || manifest.uploaderId !== uploaderId) {
      return res.status(404).json({ success: false, message: "Upload session not found." });
    }
    const alreadyCompleted = await readCompletedAttachment(manifest.uploadId);
    if (alreadyCompleted) {
      return res.status(200).json({ success: true, attachment: alreadyCompleted });
    }
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= manifest.totalChunks || !req.file) {
      return res.status(400).json({ success: false, message: "Valid chunk and chunk index are required." });
    }
    const expectedSize = index === manifest.totalChunks - 1
      ? manifest.totalSize - CHUNK_SIZE * index : CHUNK_SIZE;
    if (req.file.size !== expectedSize) {
      return res.status(400).json({ success: false, message: `Chunk ${index} has an invalid size.` });
    }
    const suppliedHash = normalizeHash(req.body.chunkHash || req.get("X-Chunk-SHA256"));
    if ((req.body.chunkHash || req.get("X-Chunk-SHA256")) && !suppliedHash) {
      return res.status(400).json({ success: false, message: `Chunk ${index} checksum is invalid.` });
    }
    const actualHash = sha256(req.file.buffer);
    if (suppliedHash && suppliedHash !== actualHash) {
      return res.status(400).json({ success: false, message: `Chunk ${index} checksum does not match.` });
    }
    await fs.writeFile(path.join(getChunkSessionDir(manifest.uploadId), `${index}.part`), req.file.buffer);
    return res.json({ success: true, uploadId: manifest.uploadId, index, chunkHash: actualHash });
  } catch (error) {
    return next(error);
  }
});

router.post("/:uploadId/complete", async (req, res, next) => {
  let finalPath;
  try {
    const manifest = await readChunkManifest(req.params.uploadId);
    const uploaderId = normalizeId(AES.getAuthUid(req));
    if (!manifest || manifest.uploaderId !== uploaderId) {
      return res.status(404).json({ success: false, message: "Upload session not found." });
    }
    const alreadyCompleted = await readCompletedAttachment(manifest.uploadId);
    if (alreadyCompleted) {
      return res.status(200).json({ success: true, attachment: alreadyCompleted });
    }
    const relativePath = `chat_attachments/${sanitize(manifest.chatId)}/${manifest.attachmentId}-${sanitize(manifest.fileName)}`;
    finalPath = resolveUploadPath(relativePath);
    if (!finalPath) return res.status(400).json({ success: false, message: "Invalid attachment path." });
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, Buffer.alloc(0));
    let assembledSize = 0;
    for (let index = 0; index < manifest.totalChunks; index += 1) {
      const chunk = await fs.readFile(path.join(getChunkSessionDir(manifest.uploadId), `${index}.part`));
      assembledSize += chunk.length;
      if (assembledSize > MAX_FILE_BYTES) throw statusError(413, `File is larger than ${maxFileSizeMb} MB.`);
      await fs.appendFile(finalPath, chunk);
    }
    if (assembledSize !== manifest.totalSize) throw statusError(400, "Assembled file size does not match upload session.");
    const inspected = await inspectFile(finalPath);
    const fileHash = inspected.hash;
    if (manifest.fileHash && manifest.fileHash !== fileHash) {
      throw statusError(400, "Assembled file checksum does not match upload session.");
    }
    if (!matchesDeclaredContent(inspected.header, manifest.kind, manifest.mimeType)) {
      throw statusError(400, "Attachment content does not match its declared type.");
    }

    const publicPath = `/files/${relativePath.replace(/\\/g, "/")}`;
    const attachment = {
      id: manifest.attachmentId,
      chatId: manifest.chatId,
      uploaderId,
      kind: manifest.kind,
      name: manifest.fileName,
      mimeType: manifest.mimeType,
      size: assembledSize,
      fullPath: relativePath.replace(/\\/g, "/"),
      url: makeDownloadUrl(req, publicPath),
      status: "pending",
      createdTime: manifest.createdTime,
      completedTime: Date.now(),
      sha256: fileHash,
    };
    await firestoreManager.createDocument("ChatAttachments", attachment.id, "/", { ...attachment });
    const sessionDir = getChunkSessionDir(manifest.uploadId);
    await fs.writeFile(path.join(sessionDir, "completed.json"), JSON.stringify(attachment));
    await Promise.all(Array.from({ length: manifest.totalChunks }, (_, index) =>
      fs.unlink(path.join(sessionDir, `${index}.part`)).catch(() => null)));
    return res.status(201).json({ success: true, attachment });
  } catch (error) {
    if (finalPath) await fs.unlink(finalPath).catch(() => null);
    return next(error);
  }
});

router.delete("/:uploadId", async (req, res, next) => {
  try {
    const manifest = await readChunkManifest(req.params.uploadId);
    const uploaderId = normalizeId(AES.getAuthUid(req));
    if (!manifest || manifest.uploaderId !== uploaderId) {
      return res.status(404).json({ success: false, message: "Upload session not found." });
    }
    await removeChunkSession(manifest.uploadId);
    return res.json({ success: true, uploadId: manifest.uploadId });
  } catch (error) {
    return next(error);
  }
});

router.post("/", upload.single("file"), async (req, res, next) => {
  let savedFile;
  try {
    const uploaderId = normalizeId(AES.getAuthUid(req));
    const chatId = String(req.body.chatId || "").trim();
    const kind = String(req.body.kind || "").trim().toLowerCase();
    if (!req.file) return res.status(400).json({ success: false, message: "Upload field 'file' is required." });
    if (!chatId || !isChatParticipant(chatId, uploaderId)) {
      return res.status(403).json({ success: false, message: "You are not a participant in this chat." });
    }
    if (!KINDS.has(kind)) {
      return res.status(400).json({ success: false, message: "kind must be image, video, or file." });
    }
    if (kind === "image" && !req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ success: false, message: "Selected file is not an image." });
    }
    if (kind === "video" && !req.file.mimetype.startsWith("video/")) {
      return res.status(400).json({ success: false, message: "Selected file is not a video." });
    }
    if (!matchesDeclaredContent(req.file.buffer, kind, req.file.mimetype)) {
      return res.status(400).json({ success: false, message: "Attachment content does not match its declared type." });
    }

    const attachmentId = crypto.randomUUID();
    savedFile = await saveFile({
      buffer: req.file.buffer,
      requestedPath: `chat_attachments/${sanitize(chatId)}/${attachmentId}-${sanitize(req.file.originalname)}`,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    const attachment = {
      id: attachmentId,
      chatId,
      uploaderId,
      kind,
      name: req.file.originalname,
      mimeType: req.file.mimetype || "application/octet-stream",
      size: req.file.size,
      fullPath: savedFile.fullPath,
      url: makeDownloadUrl(req, savedFile.publicPath),
      status: "pending",
      createdTime: Date.now(),
      sha256: sha256(req.file.buffer),
    };
    await firestoreManager.createDocument("ChatAttachments", attachmentId, "/", { ...attachment });
    return res.status(201).json({ success: true, attachment });
  } catch (error) {
    if (savedFile) await deleteFile(savedFile.fullPath).catch(() => null);
    return next(error);
  }
});

function makeDownloadUrl(req, publicPath) {
  const base = process.env.PUBLIC_BASE_URL
    ? process.env.PUBLIC_BASE_URL.replace(/\/$/, "")
    : `${req.protocol}://${req.get("host")}${(process.env.PUBLIC_PATH_PREFIX || "/pinggo-app-api").replace(/\/$/, "")}`;
  return `${base}${publicPath}`;
}

function isChatParticipant(chatId, uid) {
  return chatId.split("_").map(normalizeId).includes(uid);
}

function normalizeId(value) {
  return String(value || "").trim().replace(/^<plus>/, "").replace(/^\+/, "");
}

function sanitize(value) {
  return String(value || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function inspectFile(filePath) {
  const handle = await fs.open(filePath, "r");
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let header = Buffer.alloc(0);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      if (!header.length) header = Buffer.from(buffer.subarray(0, Math.min(bytesRead, 16)));
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { hash: digest.digest("hex"), header };
}

function matchesDeclaredContent(buffer, kind, mimeType) {
  if (kind === "file") return true;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (kind === "video") {
    return mimeType === "video/mp4"
      ? buffer.subarray(4, 8).toString("ascii") === "ftyp"
      : mimeType.startsWith("video/");
  }
  const hex = buffer.subarray(0, 12).toString("hex");
  if (mimeType === "image/jpeg") return hex.startsWith("ffd8ff");
  if (mimeType === "image/png") return hex.startsWith("89504e470d0a1a0a");
  if (mimeType === "image/gif") return buffer.subarray(0, 6).toString("ascii").startsWith("GIF8");
  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return mimeType.startsWith("image/");
}

function validateChunkInit({ chatId, uploaderId, kind, mimeType, totalSize, totalChunks }) {
  if (!chatId || !isChatParticipant(chatId, uploaderId)) return statusError(403, "You are not a participant in this chat.");
  if (!KINDS.has(kind)) return statusError(400, "kind must be image, video, or file.");
  if (kind === "image" && !mimeType.startsWith("image/")) return statusError(400, "Selected file is not an image.");
  if (kind === "video" && !mimeType.startsWith("video/")) return statusError(400, "Selected file is not a video.");
  if (!Number.isInteger(totalSize) || totalSize <= 0 || totalSize > MAX_FILE_BYTES) return statusError(413, `File must be ${maxFileSizeMb} MB or smaller.`);
  if (!Number.isInteger(totalChunks) || totalChunks !== Math.ceil(totalSize / CHUNK_SIZE)) return statusError(400, "totalChunks does not match totalSize.");
  return null;
}

function getChunkSessionDir(uploadId) {
  const safeUploadId = sanitize(uploadId);
  const sessionDir = path.resolve(chunkUploadDir, safeUploadId);
  return sessionDir.startsWith(`${chunkUploadDir}${path.sep}`) ? sessionDir : null;
}

async function readChunkManifest(uploadId) {
  const sessionDir = getChunkSessionDir(uploadId);
  if (!sessionDir) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDir, "manifest.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function removeChunkSession(uploadId) {
  const sessionDir = getChunkSessionDir(uploadId);
  if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true });
}

async function readCompletedAttachment(uploadId) {
  const sessionDir = getChunkSessionDir(uploadId);
  if (!sessionDir) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDir, "completed.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function cleanupExpiredChunkSessions() {
  if (Date.now() - lastChunkCleanupTime < 60 * 60 * 1000) return;
  lastChunkCleanupTime = Date.now();
  await fs.mkdir(chunkUploadDir, { recursive: true });
  const entries = await fs.readdir(chunkUploadDir, { withFileTypes: true });
  const cutoff = Date.now() - CHUNK_SESSION_TTL_MS;
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const sessionDir = getChunkSessionDir(entry.name);
    if (!sessionDir) return;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(sessionDir, "manifest.json"), "utf8"));
      if (!manifest.createdTime || manifest.createdTime < cutoff) {
        await fs.rm(sessionDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code === "ENOENT") await fs.rm(sessionDir, { recursive: true, force: true });
      else throw error;
    }
  }));
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  return error;
}

module.exports = router;
