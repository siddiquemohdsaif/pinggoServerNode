# Video attachment normalization

The attachment upload routes inspect every `video/mp4` with FFprobe. Fragmented
MP4 files (top-level `moof` boxes) and MP4 files without a positive duration are
remuxed with FFmpeg before their attachment record is created. The remux uses
stream copy, so it does not re-encode or reduce media quality. The normalized
file's duration, size, and SHA-256 hash are stored in the attachment metadata.

Both `ffmpeg` and `ffprobe` must be installed on the server and available on
`PATH`. Their locations can instead be configured explicitly:

```env
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe
VIDEO_NORMALIZE_TIMEOUT_MS=120000
```

On Linux, values such as `/usr/bin/ffmpeg` and `/usr/bin/ffprobe` can be used.
Confirm the installation before starting the server:

```sh
ffmpeg -version
ffprobe -version
```

If inspection or normalization fails, the upload is rejected with HTTP 422 and
the incomplete stored file is removed. The original upload checksum is checked
before remuxing; the server then calculates a new checksum for the normalized
container returned to clients.
