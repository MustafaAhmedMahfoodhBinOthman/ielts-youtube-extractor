FROM node:24-slim

# System deps: python + ffmpeg + curl, then pinned yt-dlp via pip
# (no app Python code — Node shells out to the yt-dlp binary).
# Pinned for reproducible builds; update by bumping the pin + redeploy
# (check latest at https://pypi.org/pypi/yt-dlp/json). Never `yt-dlp -U`
# inside a running container — it diverges from the image.
#
# ffmpeg drags in a large transitive set (libllvm among it) and the Debian
# mirrors intermittently fail mid-unpack. Retry the whole apt step rather
# than hand-editing the package list: a partial dpkg state is not worth
# special-casing, and a clean retry is what actually recovers.
RUN set -eux; \
  for attempt in 1 2 3; do \
    if apt-get update \
      && apt-get install -y --no-install-recommends \
         python3 python3-pip ffmpeg curl ca-certificates; then \
      break; \
    fi; \
    if [ "$attempt" = "3" ]; then echo "apt failed after 3 attempts" >&2; exit 1; fi; \
    echo "apt attempt $attempt failed; cleaning dpkg state and retrying"; \
    rm -rf /var/lib/apt/lists/*; \
    dpkg --configure -a || true; \
    apt-get clean; \
    sleep 5; \
  done; \
  rm -rf /var/lib/apt/lists/*; \
  pip3 install --no-cache-dir --break-system-packages yt-dlp==2026.8.19

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
