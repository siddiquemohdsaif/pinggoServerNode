const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs").promises;

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

async function normalizeUploadedVideo(filePath, mimeType, options = {}) {
  if (String(mimeType || "").toLowerCase() !== "video/mp4") return null;

  const run = options.run || runProcess;
  const ffprobe = options.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
  const ffmpeg = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const timeoutMs = positiveNumber(options.timeoutMs || process.env.VIDEO_NORMALIZE_TIMEOUT_MS)
    || DEFAULT_TIMEOUT_MS;
  const before = await probeVideo(filePath, { run, ffprobe, timeoutMs });
  const fragmented = await hasTopLevelBox(filePath, "moof");
  const needsRemux = fragmented || !positiveNumber(before.durationSeconds);

  if (!needsRemux) {
    return { durationMs: toDurationMs(before.durationSeconds), normalized: false };
  }

  const temporaryPath = `${filePath}.normalizing-${crypto.randomUUID()}.mp4`;
  try {
    await run(ffmpeg, [
      "-v", "error", "-nostdin", "-y", "-i", filePath,
      // Chat videos only need playable media tracks. Some camera/export tools add
      // timecode or private data streams (for example tmcd/codec none) which cannot
      // be copied into the normalized MP4 and cause FFmpeg to reject its header.
      "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-dn",
      "-map_metadata", "-1", "-write_tmcd", "0",
      "-movflags", "+faststart", temporaryPath,
    ], timeoutMs);
    const after = await probeVideo(temporaryPath, { run, ffprobe, timeoutMs });
    if (!positiveNumber(after.durationSeconds)) {
      throw processingError("Normalized video has no valid duration.");
    }
    await replaceFile(filePath, temporaryPath);
    return { durationMs: toDurationMs(after.durationSeconds), normalized: true };
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => null);
    if (error.statusCode) throw error;
    throw processingError(`Video normalization failed: ${error.message}`, error);
  }
}

async function probeVideo(filePath, { run = runProcess, ffprobe = "ffprobe",
  timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = await run(ffprobe, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "json", filePath,
    ], timeoutMs);
  } catch (error) {
    throw processingError(`Unable to inspect uploaded video: ${error.message}`, error);
  }
  try {
    const data = JSON.parse(result.stdout || "{}");
    return { durationSeconds: Number(data.format && data.format.duration) };
  } catch (error) {
    throw processingError("FFprobe returned invalid video metadata.", error);
  }
}

async function hasTopLevelBox(filePath, wantedType) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    let offset = 0;
    const header = Buffer.alloc(16);
    while (offset + 8 <= stat.size) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      let size = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString("ascii");
      let headerSize = 8;
      if (type === wantedType) return true;
      if (size === 1) {
        if (bytesRead < 16) return false;
        const largeSize = header.readBigUInt64BE(8);
        if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        size = Number(largeSize);
        headerSize = 16;
      } else if (size === 0) {
        size = stat.size - offset;
      }
      if (size < headerSize || offset + size > stat.size) return false;
      offset += size;
    }
    return false;
  } finally {
    await handle.close();
  }
}

async function replaceFile(originalPath, replacementPath) {
  const backupPath = `${originalPath}.original-${crypto.randomUUID()}`;
  await fs.rename(originalPath, backupPath);
  try {
    await fs.rename(replacementPath, originalPath);
    await fs.unlink(backupPath);
  } catch (error) {
    await fs.rename(backupPath, originalPath).catch(() => null);
    throw error;
  }
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function toDurationMs(seconds) {
  return Math.max(1, Math.round(Number(seconds) * 1000));
}

function processingError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = 422;
  error.statusCode = 422;
  return error;
}

module.exports = { hasTopLevelBox, normalizeUploadedVideo, probeVideo };
