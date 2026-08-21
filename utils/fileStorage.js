const crypto = require("crypto");
const path = require("path");
const fs = require("fs").promises;

const defaultUploadDir = process.platform === "win32"
  ? path.join(__dirname, "..", "public")
  : "/PinggoServerNode/public";
const uploadDir = path.resolve(process.env.UPLOAD_DIR || defaultUploadDir);
const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB || 25);

function sanitizeName(name) {
  return String(name || "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function makeUniqueFileName(originalName) {
  const ext = path.extname(originalName);
  const baseName = sanitizeName(path.basename(originalName, ext)) || "file";
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}-${baseName}${ext}`;
}

function getSafeRelativeUploadPath(requestedPath, originalName) {
  const normalizedRequest = String(requestedPath || "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+/, "");

  if (!normalizedRequest) {
    return makeUniqueFileName(originalName);
  }

  const isDirectoryPath = normalizedRequest.endsWith("/");
  const safeParts = normalizedRequest
    .split("/")
    .filter(Boolean)
    .map(sanitizeName)
    .filter((part) => part && part !== "." && part !== "..");

  if (safeParts.length === 0) {
    return makeUniqueFileName(originalName);
  }
  if (isDirectoryPath) {
    safeParts.push(makeUniqueFileName(originalName));
  }
  return safeParts.join("/");
}

function resolveUploadPath(relativePath) {
  const targetPath = path.resolve(uploadDir, relativePath);
  return targetPath.startsWith(`${uploadDir}${path.sep}`) ? targetPath : null;
}

async function saveFile({ buffer, requestedPath, originalName = "file", mimeType }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("File data must be a Buffer.");
  }
  if (buffer.length > maxFileSizeMb * 1024 * 1024) {
    const error = new Error(`File is larger than ${maxFileSizeMb} MB.`);
    error.statusCode = 413;
    throw error;
  }

  const relativePath = getSafeRelativeUploadPath(requestedPath, originalName);
  const targetPath = resolveUploadPath(relativePath);
  if (!targetPath) {
    const error = new Error("Invalid upload path.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buffer);
  return {
    originalName,
    fileName: path.basename(relativePath),
    fullPath: relativePath.replace(/\\/g, "/"),
    mimeType: mimeType || "application/octet-stream",
    size: buffer.length,
    publicPath: `/files/${relativePath.replace(/\\/g, "/")}`,
  };
}

async function getFile(relativePath) {
  const safePath = getSafeRelativeUploadPath(relativePath, "file");
  const targetPath = resolveUploadPath(safePath);
  if (!targetPath) return null;
  try {
    const stat = await fs.stat(targetPath);
    return { fullPath: safePath.replace(/\\/g, "/"), size: stat.size };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function deleteFile(relativePath) {
  const file = await getFile(relativePath);
  if (!file) return null;
  await fs.unlink(resolveUploadPath(file.fullPath));
  return file;
}

module.exports = {
  deleteFile,
  getFile,
  maxFileSizeMb,
  saveFile,
  uploadDir,
};
