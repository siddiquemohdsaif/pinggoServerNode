const assert = require("node:assert/strict");
const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hasTopLevelBox, normalizeUploadedVideo, probeVideo } =
  require("../services/videoNormalizationService");

function box(type, payload = Buffer.alloc(0)) {
  const value = Buffer.alloc(8 + payload.length);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, 4, "ascii");
  payload.copy(value, 8);
  return value;
}

test("detects fragmented MP4 top-level moof boxes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pinggo-video-"));
  const file = path.join(directory, "fragmented.mp4");
  try {
    await fs.writeFile(file, Buffer.concat([box("ftyp"), box("moov"), box("moof"), box("mdat")]));
    assert.equal(await hasTopLevelBox(file, "moof"), true);
    assert.equal(await hasTopLevelBox(file, "mfra"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("parses FFprobe duration without invoking a shell", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    return { stdout: JSON.stringify({ format: { duration: "14.250000" } }), stderr: "" };
  };
  const result = await probeVideo("uploaded.mp4", { run, ffprobe: "custom-ffprobe" });
  assert.equal(result.durationSeconds, 14.25);
  assert.equal(calls[0].command, "custom-ffprobe");
  assert.deepEqual(calls[0].args.slice(-1), ["uploaded.mp4"]);
});

test("rejects malformed FFprobe output", async () => {
  const run = async () => ({ stdout: "not-json", stderr: "" });
  await assert.rejects(() => probeVideo("uploaded.mp4", { run }), {
    statusCode: 422,
    message: "FFprobe returned invalid video metadata.",
  });
});

test("normalization maps video and optional audio while dropping data streams", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pinggo-video-"));
  const file = path.join(directory, "fragmented.mp4");
  const calls = [];
  try {
    await fs.writeFile(file, Buffer.concat([box("ftyp"), box("moof"), box("mdat")]));
    const run = async (command, args) => {
      calls.push({ command, args });
      if (command === "ffprobe") {
        const duration = calls.filter((call) => call.command === "ffprobe").length === 1
          ? "0" : "8.500000";
        return { stdout: JSON.stringify({ format: { duration } }), stderr: "" };
      }
      await fs.writeFile(args.at(-1), Buffer.concat([box("ftyp"), box("moov"), box("mdat")]));
      return { stdout: "", stderr: "" };
    };
    const result = await normalizeUploadedVideo(file, "video/mp4", { run });
    const ffmpeg = calls.find((call) => call.command === "ffmpeg");
    assert.deepEqual(ffmpeg.args.slice(6, 18), [
      "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-dn",
      "-map_metadata", "-1", "-write_tmcd", "0", "-movflags",
    ]);
    assert.deepEqual(result, { durationMs: 8500, normalized: true });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
