# PingGo Server Node

PingGo Server Node is the HTTP and realtime backend for the PingGo Android application. It provides authentication, chats, groups, attachments, presence, multi-device synchronization, notifications, call signalling, a legacy media relay, and LiveKit token issuance.

The service uses Express 5, `ws`, Firebase Admin, a Firestore REST gateway, local file storage, and optional LiveKit and FFmpeg integrations.

## Responsibilities

- Login, signup, reactivation, and account deletion
- SMS/email OTP and Google identity verification
- One-to-one and group messaging
- Receipts, editing, deletion, forwarding, and pinning
- Discovery, chat settings, blocking, reporting, and synchronization
- Presence and typing updates
- Call signalling, logs, missed calls, and LiveKit tokens
- Legacy binary JPEG video relay
- Multipart and resumable attachment uploads
- MP4 inspection and lossless remuxing
- FCM notifications
- Companion-device pairing, fan-out, heartbeat, logout, and revocation

## Requirements

- A supported Node.js LTS release and npm
- Access to the configured Firestore REST gateway
- Firebase Application Default Credentials for notifications
- FFmpeg and FFprobe when accepting MP4 attachments
- A LiveKit deployment when Android uses the LiveKit call engine

## Installation

```sh
npm install
```

Create an uncommitted `.env` file. Representative settings are:

```env
PRODUCTION_TYPE=development

UPLOAD_DIR=/absolute/path/to/pinggo-uploads
MAX_FILE_SIZE_MB=25
PUBLIC_BASE_URL=https://example.com
PUBLIC_PATH_PREFIX=/pinggo-app-api
CHUNK_UPLOAD_DIR=/absolute/path/to/pinggo-upload-sessions
CHUNK_SESSION_TTL_HOURS=24

FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
VIDEO_NORMALIZE_TIMEOUT_MS=120000

LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_API_KEY=replace-me
LIVEKIT_API_SECRET=replace-me

WEBRTC_STUN_URLS=stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478
WEBRTC_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
WEBRTC_TURN_USERNAME=replace-me
WEBRTC_TURN_CREDENTIAL=replace-me

GOOGLE_WEB_CLIENT_ID=replace-me.apps.googleusercontent.com
EMAIL_USER=sender@example.com
EMAIL_PASSWORD=replace-me
EMAIL_FROM=PingGo <sender@example.com>

DEXATEL_API_KEY=replace-me
DEXATEL_SENDER=PingGo
DEXATEL_TEMPLATE_ID=replace-me
DEXATEL_OTP_CODE_LENGTH=6
```

Legacy email names (`EMAIL`, `EMAIL_APP_PASSWORD`) and MSG91 variables are also recognized. Configure only the integrations used by the deployment.

The Firestore gateway endpoint and token come from `Firestore/config-cloudsw3_dev.json` or `Firestore/config-cloudsw3.json`, selected by `PRODUCTION_TYPE`. Keep production credentials outside source control in a real deployment.

## Running

```sh
npm run run
```

- `PRODUCTION_TYPE=release`: port `4100`
- any other value or unset: port `4200`

```sh
curl http://localhost:4200/healthCheck
```

The HTTP server accepts WebSocket upgrades at `/ws` and `/media`.

## HTTP API

Public or flow-specific routes:

- `/healthCheck`
- `/checkUserExists`
- `/login`
- `/otp/*`
- `/signup`
- `/auth/google`
- `/device-links/*`
- general file routes

Protected route groups:

- `/profile/*`
- `/chats/*`
- `/chats/attachments/*`
- `/calls/*`
- `/groups/*`
- `/devices/*`
- `/account/*`

Notable operations include chat list/history/sync, group membership, resumable uploads, device revocation, call-log pagination, and `POST /calls/livekit/token`. Failures return an appropriate HTTP status with a JSON `message`.

## Authentication

REST middleware validates custom encrypted PingGo credentials and extracts account/device claims. Requests are rejected when the credential is invalid, the account is deleted, the primary session is stale, or a device-bound companion credential is revoked.

WebSocket clients connect to `/ws`, receive `connection_ready`, then must send `auth` and wait for `auth_success`. These credentials are not standard JWTs and must be treated as sensitive.

## Realtime protocol

The `/ws` signalling socket handles events including:

```text
auth
send_message
send_group_message
message_delivered
message_seen
edit_message
delete_message
delete_messages
delete_opponent_message
pin_messages
unpin_messages
forward_messages
active_chat
typing_start
typing_stop
call_*
ice_candidate
```

Responses include acknowledgements, failures, `new_message`, mutations, presence, typing, group updates, and call events. Several devices may be online for one account, with selective cross-device fan-out.

`/media` supports the legacy video engine: it maintains call rooms, broadcasts participant/media state, and relays binary JPEG frames. It is not a WebRTC SFU. LiveKit is used when Android selects the LiveKit engine.

## Persistence

Structured data is accessed through `Firestore/FirestoreManager.js`, which calls the configured Firestore REST gateway.

Messages and calls use `models/ShardedDocumentStore.js`. A new document is created before reaching approximately 2,000 entries or 800 KiB of JSON, leaving headroom below Firestore's 1 MiB limit.

Files are stored under `UPLOAD_DIR`. The default is local `public/` on Windows and `/PinggoServerNode/public` elsewhere. Static files are exposed under `/files`. Set `PUBLIC_BASE_URL` and `PUBLIC_PATH_PREFIX` to match the reverse proxy.

## Attachments and video normalization

The server supports multipart and resumable chunk uploads. The default maximum size is 25 MiB.

Every `video/mp4` is inspected with FFprobe. Fragmented MP4s or files without a positive duration are remuxed with FFmpeg using stream copy, preserving quality. Duration, size, and SHA-256 metadata are updated. Failures return HTTP 422 and incomplete files are removed. See `VIDEO_NORMALIZATION.md`.

## Firebase notifications

Firebase Admin uses Application Default Credentials. Locally, point `GOOGLE_APPLICATION_CREDENTIALS` to a service-account file outside the repository. In managed hosting, prefer workload/service identity.

FCM notifications cover new messages, calls, account logout, and linked-device activity.

## LiveKit

All three variables are required:

```env
LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_API_KEY=replace-me
LIVEKIT_API_SECRET=replace-me
```

Tokens are room-scoped, use the PingGo account ID as participant identity, and expire after 15 minutes. Voice tokens permit microphone publication; video tokens permit microphone and camera publication.

## Legacy WebRTC ICE

Legacy WebRTC calls fetch their STUN/TURN list from the authenticated
`GET /calls/webrtc/ice` endpoint. A TURN relay is required for reliable calls
between mobile networks and restrictive NATs. Set `WEBRTC_TURN_URLS`,
`WEBRTC_TURN_USERNAME`, and `WEBRTC_TURN_CREDENTIAL` together. If they are
omitted, the endpoint returns only the configured/default STUN servers.

## Project layout

```text
index.js        Express and WebSocket entry point
routes/         HTTP handlers
realtime/       signalling, presence, calls, FCM, media relay
services/       groups, devices, deletion, LiveKit, video processing
models/         account, device, call, attachment, sharded stores
utils/          credentials, OTP, email, files, validation, config
Firestore/      Firestore REST client and configuration
Firebase/       Firebase Admin initialization
test/           tests and migration utilities
```

## Tests

```sh
npm test
```

Tests cover multi-device connections, device credentials and pairing, attachment storage, LiveKit token grants, and video normalization.

Run the syntax checks and complete test gate with:

```sh
npm run check
```

## Performance and observability

`GET /internal/metrics` reports bounded-window p50/p95/p99 HTTP, datastore,
attachment and WebSocket acknowledgement latency together with event-loop delay,
process memory/CPU, error counters, connection counts and transferred bytes. Set
`METRICS_TOKEN` in production and send it as a Bearer token.

Useful production limits are configurable without code changes:

```env
METRICS_TOKEN=replace-me
JSON_BODY_LIMIT=1mb
DATASTORE_TIMEOUT_MS=10000
DATASTORE_MAX_SOCKETS=32
SLOW_DATASTORE_QUERY_MS=750
WS_MAX_PAYLOAD_BYTES=262144
WS_MAX_PENDING_EVENTS=128
WS_MAX_BUFFERED_BYTES=1048576
WS_HEARTBEAT_MS=30000
MAX_CONCURRENT_UPLOADS=8
MAX_CONCURRENT_UPLOADS_PER_USER=2
REDIS_URL=redis://127.0.0.1:6379
```

Redis is optional for local development. When configured, it supplies durable
notification retries, restart-safe direct/group message idempotency, shared OTP
and authentication rate limits, and short-lived user/group caches. Active
WebSocket objects remain in the Node process because they cannot be serialized.

After starting a test instance, run the repeatable HTTP latency gate:

```sh
npm run load:test
```

Configure it with `LOAD_TEST_URL`, `LOAD_TEST_REQUESTS`,
`LOAD_TEST_CONCURRENCY`, and `LOAD_TEST_MAX_P95_MS`. Point it at authorized
chat, group, call, or upload test endpoints in an isolated environment; never
load-test production user data.

## Migrations

Always preview first:

```sh
npm run migrate:sharded:dry-run
npm run migrate:attachments:dry-run
```

After verifying configuration and backups:

```sh
npm run migrate:sharded
npm run migrate:attachments
```

The non-dry-run commands modify persistent data.

## Deployment

- Use a reverse proxy with WebSocket upgrades for `/ws` and `/media`.
- Use HTTPS/WSS in production.
- Persist and back up `UPLOAD_DIR`.
- Install and verify FFmpeg/FFprobe before accepting traffic.
- Provide Firebase and gateway credentials through secret management.
- Monitor disk usage, rejected uploads, socket counts, FCM failures, and normalization timeouts.
- Apply infrastructure-level rate limits, especially to OTP and uploads.

## Troubleshooting

- **Unexpected port:** only the exact value `release` selects port 4100.
- **HTTP 401:** verify credential, current primary session, and device revocation state.
- **`auth_required`:** authenticate the socket and wait for `auth_success`.
- **Push failure:** verify Firebase credentials and the current FCM token.
- **Wrong attachment URLs:** align public URL/prefix, reverse-proxy mount, and `/files` routing.
- **MP4 HTTP 422:** verify FFmpeg/FFprobe paths and input validity.
- **LiveKit HTTP 503:** one or more LiveKit variables are missing.
- **Firestore failure:** verify the selected gateway config and token.

## Security notes

This service processes credentials, phone numbers, messages, device metadata, and uploaded files. Production operation should include TLS, secret management, strict gateway access, upload scanning and retention policies, rate limiting, audit logs, dependency patching, and tested backup/restore procedures.
