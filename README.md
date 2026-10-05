# ielts-youtube-extractor

Standalone microservice: `YouTube URL → MP3 (128k) → Cloudflare R2 → playable audio_url`.

Used by the IELTS Mastery admin panel to create Listening prediction tests.
Admin pastes a YouTube URL, this service extracts audio-only as MP3, uploads
to R2, and returns a public `audio_url`. Reading tests don't use this.
Low volume, admin-only, max 2 concurrent jobs.

Stack: Node 24 + TypeScript + Express + `fluent-ffmpeg` + `@aws-sdk/client-s3`.
No Python app code — Node shells out to the `yt-dlp` binary.
Listens on `PORT` (default 3000).

## Env

| Var | Required | Description |
| --- | --- | --- |
| `PORT` | no (default 3000) | HTTP port |
| `ADMIN_TOKEN` | yes | Bearer token for `POST /extract` |
| `R2_ENDPOINT` | yes | e.g. `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | yes | R2 S3-compat key |
| `R2_SECRET_ACCESS_KEY` | yes | R2 S3-compat secret (never logged) |
| `R2_BUCKET` | yes | e.g. `ielts-audio` |
| `R2_PUBLIC_URL` | yes | e.g. `https://pub-<id>.r2.dev` (no trailing slash needed) |
| `YTDLP_COOKIES_B64` | no | base64 of Netscape `cookies.txt` for 429/403 recovery |
| `ALLOWED_ORIGINS` | no | comma-separated CORS origins (e.g. `https://admin.example.com`). Empty = default deny: browser cross-origin rejected 403; same-origin + curl/no-Origin allowed |
| `LOG_LEVEL` | no (default `info`) | `debug` = per-stage diagnostics (queue, auth outcome, oEmbed, yt-dlp spawn/exit, ffprobe, R2, job transitions). Never logs tokens/secrets |

```bash
cp .env.example .env
# fill in ADMIN_TOKEN + R2_* values
```

## Run

```bash
npm ci
npm run dev        # tsx watch src/index.ts (http://localhost:3000)
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm test           # vitest run (validate + queue gate tests)
```

Memory: R2 uploads stream from disk (constant RAM) — sized for `medium-1x`.

Two modes, selected per request with `kind`:
- `audio` (default) — 128kbps mp3, optional `start_time`/`end_time` trim.
- `video` — 480p h264+aac mp4 (height via `max_height`), always full length,
  300MB cap, 600s timeout.

Docker (cold build installs python3/pip/ffmpeg + pinned `yt-dlp==2026.8.19`):

```bash
docker build -t ielts-youtube-extractor .
docker run --rm -p 3000:3000 --env-file .env ielts-youtube-extractor
```

## Endpoints

### `GET /health`

No auth. Returns versions captured at startup:

```json
{ "ok": true, "ytDlp": "2025.x.x", "ffmpeg": "ffmpeg version 6.x ..." }
```

```bash
curl -s http://localhost:3000/health
```

### `POST /extract`

Auth: `Authorization: Bearer $ADMIN_TOKEN` (constant-time compare, 401 if missing/wrong).
Sends `Cache-Control: no-store`.

Default is **async** (avoids gateway timeouts on 30–120s jobs):

```bash
# submit -> 202 {jobId}
curl -s -X POST http://localhost:3000/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","title_hint":"ielts-listening-test-1"}'
# {"success":true,"jobId":"...","status":"queued"}

# poll until done/failed (job record kept 1h; /tmp cleaned per job)
curl -s http://localhost:3000/job/<jobId> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# running: {"success":true,"jobId":"...","status":"running","youtube_id":"..."}
# done:    {"success":true,"jobId":"...","status":"done","result":{"audio_url":"...","r2Key":"...","title":"...","duration_seconds":1423,"size":12345678}}
# failed:  {"success":true,"jobId":"...","status":"failed","error":{"code":"blocked_429",...}}

# poll loop
JOB=<jobId>; while true; do
  R=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/job/$JOB)
  echo "$R" | grep -q '"status":"done"\|"status":"failed"' && { echo "$R"; break; }
  sleep 5
done
```

Local-dev **sync** path (`?wait=true`, request waits 30–120s, may hit gateway
timeouts in prod — prefer async):

```bash
curl -s -m 300 -X POST 'http://localhost:3000/extract?wait=true' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","title_hint":"ielts-listening-test-1"}'
```

Body:

```json
{
  "youtube_url": "https://www.youtube.com/watch?v=...",
  "title_hint": "optional-short-title",
  "start_time": "1:00",
  "end_time": "8:24"
}
```

| `kind` | no (default `audio`) | `audio` = 128kbps mp3 for the Listening test; `video` = 480p h264/aac mp4 for video models that can't open a YouTube URL |
| `max_height` | no (default `480`) | video mode only: cap the video height (144–2160) |

`start_time`/`end_time` are optional (seconds number/string or
`mm:ss` / `hh:mm:ss`). Defaults: start `0`, end omitted = full audio
(backward compatible). Trimming downloads only the section via
`yt-dlp --download-sections` — no post-download ffmpeg step. Sections require
the ffmpeg downloader (`--downloader ffmpeg`, added only when trimming), so
trimmed jobs are slower than full-audio ones and cuts are exact
(`--force-keyframes-at-cuts` re-encodes around the boundaries).

**`kind: "video"` is always full length** — `start_time`/`end_time` are
rejected with 400 `invalid_range` rather than silently returning the whole
video.

Accepted URL forms: `youtube.com/watch?v=ID`, `youtube.com/shorts/ID`,
`youtube.com/embed/ID`, `youtu.be/ID` (11-char ID, else 400 `invalid_url`).

Pipeline:

1. oEmbed title/author + `yt-dlp --print` metadata (8 fields, bounded output).
   Rejects live / private / age-restricted / `duration > 3600s` with 400 `rejected`.
2. Max 2 concurrent extractions; extras get 429 `{success:false,code:"busy_retry"}`.
3. `yt-dlp -f bestaudio/best -x --audio-format mp3 --audio-quality 128K --no-playlist --max-filesize 100M`
   with 240s timeout. 429/403 → 502 `blocked_429` (refresh cookies / update yt-dlp).
   >100MB → 413 `too_large`.
4. `ffprobe` duration + size check; filename
   `{sanitized-title-or-title_hint}-{youtube_id}-{Date.now()}.mp3`
   (lowercase, `[^a-z0-9]+`→`-`, slug max 80 chars).
5. R2 upload (`predictions/{filename}`, `ContentType: audio/mpeg`) → public URL
   from `R2_PUBLIC_URL/{key}`. `/tmp/yt-{uuid}` cleaned in `finally`.

Success (200):

```json
{
  "success": true,
  "audio_url": "https://pub-xxx.r2.dev/predictions/slug-VIDEOID-123.mp3",
  "r2Key": "predictions/slug-VIDEOID-123.mp3",
  "youtube_id": "VIDEOID",
  "title": "IELTS Listening ...",
  "duration_seconds": 474,
  "size": 4567890,
  "trimmed": true,
  "start_seconds": 30,
  "end_seconds": 504,
  "original_duration_seconds": 1823
}
```

For `kind: "video"` the result adds `kind: "video"` and `video_url` (same
object as `audio_url`, named explicitly), is an `.mp4`, and has
`trimmed: false` with null `start_seconds`/`end_seconds`.

```bash
# 480p mp4 for a video model (full length)
curl -s -X POST http://localhost:3000/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","kind":"video"}'

# cap the height lower (144-2160; default 480)
curl -s -X POST http://localhost:3000/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","kind":"video","max_height":360}'

# video + a range is rejected (video is always full length)
# -> 400 {success:false,code:"invalid_range",error:"start_time/end_time are not supported with kind=video ..."}
```

(`trimmed:false` → `start_seconds`/`end_seconds` are null; `duration_seconds`
is the uploaded file's probed length, `original_duration_seconds` the full video.)

### Trimming

```bash
# first 8:24 of the video
curl -s -X POST http://localhost:3000/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","end_time":"8:24"}'

# 0:30 -> 10:00 (mixed seconds number + mm:ss string)
curl -s -X POST http://localhost:3000/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","start_time":30,"end_time":"10:00"}'

# end beyond the video -> invalid_range with the real duration.
# Sync (?wait=true) fails fast with an immediate HTTP 400:
curl -s -X POST 'http://localhost:3000/extract?wait=true' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","end_time":"99:99:99"}'
# -> 400 {success:false,code:"invalid_range",error:"end_time ... exceeds video duration ...s"}
# Default async instead returns 202, then the job reports it:
# GET /job/<id> -> {status:"failed",error:{code:"invalid_range",...}}

# malformed range -> 400 invalid_range
curl -s -X POST http://localhost:3000/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID","start_time":60,"end_time":30}'
# -> 400 {success:false,code:"invalid_range",error:"end_time (30s) must be greater than start_time (60s)"}
```

The service verifies the trimmed mp3 (`ffprobe` ≈ `end - start`, ±5s) and
refuses to upload on mismatch — never silently the wrong file.

```bash
# health
curl -s http://localhost:3000/health

# verify the mp3
curl -s -o /tmp/out.mp3 "$AUDIO_URL"
ffprobe -v error -show_entries format=duration,size,bit_rate -show_entries stream=codec_name,bit_rate -of default=nw=1 /tmp/out.mp3

# error cases
curl -s -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID"}'
# -> 401 {success:false,code:"unauthorized"}

curl -s -X POST http://localhost:3000/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://example.com/not-youtube"}'
# -> 400 {success:false,code:"invalid_url"}

# unknown job
curl -s http://localhost:3000/job/nope -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 404 {success:false,code:"not_found"}

# concurrency gate: 5 parallel submits -> 2 accepted (202), 3 get 429 busy_retry
for i in 1 2 3 4 5; do
  curl -s -o /tmp/sub$i.json -w "$i:%{http_code}\n" -X POST http://localhost:3000/extract \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID"}' &
done; wait
# (automated equivalent: npm test — queue.test.ts asserts 2 run / 3 rejected)
```

### `GET /job/:id`

Auth required. Returns `{status: queued|running|done|failed, result|error}`.
Unknown/expired id → 404 `not_found`. Use for Trigger.dev polling: submit
via `POST /extract`, poll `GET /job/:id` until `done`/`failed`.

## Error codes

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | missing/wrong Bearer token |
| 400 | `invalid_url` | host/path/ID not an accepted YouTube form, or bad body |
| 400 | `rejected` | live / private / age-restricted / >60min |
| 400 | `invalid_range` | bad trim range (negative, `end<=start`, immediate 400), range outside video duration (async: via failed job; `?wait=true`: immediate 400), or a range passed with `kind:"video"` |
| 502 | `video_merge_failed` | video mode: no mp4 produced (missing ffmpeg, no 480p pair, or the source has no video stream) |
| 429 | `busy_retry` | 2 jobs already running — retry shortly |
| 404 | `not_found` | unknown/expired `GET /job/:id` |
| 403 | `forbidden` | browser cross-origin request, origin not allowlisted (see CORS) |
| 413 | `too_large` | audio >100MB |
| 502 | `blocked_429` | YouTube 429/403 — refresh `YTDLP_COOKIES_B64` / redeploy pinned yt-dlp |
| 504 | `timeout` | yt-dlp exceeded 240s |
| 500 | `extract_failed` / `misconfigured` | other failure / `ADMIN_TOKEN` missing |

`POST /extract` returns 202 on async accept; `?wait=true` returns 200 + result.

## CORS

Default deny when `ALLOWED_ORIGINS` is empty: requests without an `Origin`
header (curl, server-side, same-origin navigations) are allowed; browser
requests with a foreign `Origin` get 403 `forbidden`. Same-origin browser
calls (`Origin` host === `Host`) are allowed. Set `ALLOWED_ORIGINS` to the
admin UI origin when the panel calls this service from a browser.

## Tests

```bash
npm test   # vitest: validate.test.ts (URL forms, slugs, filenames)
           # + queue.test.ts (admission gate: 5 parallel -> 2 run, 3 get 429)
           # + range.test.ts (time parsing, H:MM:SS, duration bounds, sections)
           # + extract.test.ts (--print metadata parser, NA variants)
```

## Logging

`LOG_LEVEL=debug` traces every stage of a job:

```
[http] POST /extract origin=none
[auth] accept POST /extract
[extract] input videoId=dQw4w9WgXcQ hint=yes
[queue] ADMIT active=0 pending=0 max=2
[job ...] tmp ready dir=/tmp/yt-...
[validate] ok videoId=... host=www.youtube.com
[oembed] hit videoId=... elapsedMs=231 title="..." author="..."
[meta] fetch url=... cookies=no
[yt-dlp] spawn: yt-dlp --dump-single-json ... timeoutMs=60000
[yt-dlp] exit: yt-dlp code=0 elapsedMs=1843 timedOut=false ...
[meta] parsed duration=1423 isLive=false liveStatus=null availability=public ...
[meta] allowed duration=1423 ...
[extract] start url=... tmpDir=... cookies=no
[extract] tmp listing count=1 mp3=1 ...
[ffprobe] file=... sizeBytes=... durationSeconds=...
[r2] upload start bucket=ielts-audio key=predictions/... sizeBytes=...
[r2] upload done key=... elapsedMs=912
[job ...] tmp cleaned dir=...
```

Guarantee: logs never contain `ADMIN_TOKEN`, `Authorization` values,
`R2_SECRET_ACCESS_KEY`, cookie file contents, or full env — presence only
(`set`/`missing`). yt-dlp args log the cookies *path*, never its contents.

### Diagnosing metadata failures

Metadata comes from `yt-dlp --print` (8 short lines: title, duration,
is_live, live_status, availability, age_limit, uploader, channel) — never a
full JSON dump, so caption/format-heavy videos can't break parsing by size.
`LOG_LEVEL=debug` adds `[meta] raw ... stdoutBytes=` lines per job.

- `returned N lines, expected 8` → yt-dlp printed something unexpected;
  the error carries the raw output excerpt + stderr tail.
- `metadata failed: ...` (non-zero exit) → see exit code / stderr tail;
  `blocked_429` means refresh `YTDLP_COOKIES_B64` or bump the pinned yt-dlp.

Secrets (`ADMIN_TOKEN`, full R2 secret) are never logged; startup logs only
show presence (`set`/`missing`) and cookie status.

## Cranl deploy (Riyadh)

Fresh GitHub repo (do not reuse ieltsmastery):

```bash
git init
git add -A && git commit -m "feat: ielts-youtube-extractor v1"
gh repo create ielts-youtube-extractor --public --source=. --push
```

Flow A — prebuilt image (recommended):

```bash
# 1. Build + push (yt-dlp is pinned in Dockerfile for reproducible builds)
docker build -t <registry>/ielts-youtube-extractor:1.0.0 .
docker push <registry>/ielts-youtube-extractor:1.0.0

# 2. Create the Docker app
cranl create_docker_app name=ielts-youtube-extractor region=riyadh-1 \
  image=<registry>/ielts-youtube-extractor:1.0.0 port=3000
```

Flow B — build from source on Cranl:

```bash
cranl deploy_source app=ielts-youtube-extractor build=dockerfile \
  repo=<you>/ielts-youtube-extractor branch=main dockerfile=./Dockerfile port=3000
```

Then (both flows):

```bash
# 3. Env vars
cranl set_env --app ielts-youtube-extractor \
  ADMIN_TOKEN="<long-random>" \
  R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  R2_ACCESS_KEY_ID="<key>" \
  R2_SECRET_ACCESS_KEY="<secret>" \
  R2_BUCKET="ielts-audio" \
  R2_PUBLIC_URL="https://pub-<id>.r2.dev" \
  YTDLP_COOKIES_B64="<optional base64 cookies.txt>" \
  ALLOWED_ORIGINS="https://admin.yourdomain.com"

# 4. Health check + safe rollouts
cranl check_app_health --app ielts-youtube-extractor --path /health
cranl configure_app --app ielts-youtube-extractor --auto_rollback true

# 5. Deploy + verify
cranl deploy --app ielts-youtube-extractor
curl -s https://<app-url>/health
curl -s -X POST https://<app-url>/extract \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=VIDEOID"}'
```

Updating yt-dlp (YouTube changes break extractors often):

```bash
# Check what's running (diagnostic only — does NOT persist):
cranl run_command --app ielts-youtube-extractor -- yt-dlp --version

# Durable update: bump the pin in Dockerfile, rebuild + redeploy
#   pip3 install ... yt-dlp==<new-stable>   (see https://pypi.org/pypi/yt-dlp/json)
docker build -t <registry>/ielts-youtube-extractor:1.0.1 .
docker push <registry>/ielts-youtube-extractor:1.0.1
cranl deploy --app ielts-youtube-extractor --image <registry>/ielts-youtube-extractor:1.0.1
```

If 502 `blocked_429` persists: export fresh cookies from a logged-in browser
(`cookies.txt`, Netscape format), `base64 -i cookies.txt`, set as
`YTDLP_COOKIES_B64`, redeploy.
