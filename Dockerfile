FROM node:24-slim

# System deps: python + ffmpeg + curl, then pinned yt-dlp via pip
# (no app Python code — Node shells out to the yt-dlp binary).
# Pinned for reproducible builds; update by bumping the pin + redeploy
# (check latest at https://pypi.org/pypi/yt-dlp/json). Never `yt-dlp -U`
# inside a running container — it diverges from the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp==2026.8.19

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
