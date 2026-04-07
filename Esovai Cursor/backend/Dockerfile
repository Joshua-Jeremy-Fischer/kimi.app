FROM node:20-alpine

# Build-Tools + Chromium für Playwright (headless Browser-Suche)
RUN apk add --no-cache \
    python3 make g++ \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont udev

# Playwright soll NICHT seinen eigenen Browser runterladen — wir nutzen System-Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs

COPY package*.json ./
# npm ci bevorzugt (benötigt package-lock.json); fallback: npm install --omit=dev
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server.js agent.js auth.js push.js job-crawler.js monitor.js scheduler.js ./
COPY scripts/ ./scripts/

# FIM-Hashes beim Build (kein mehrzeiliges RUN node -e — das bricht den Dockerfile-Parser)
RUN node scripts/fim-gen.cjs

USER nodejs
EXPOSE 3010
CMD ["node", "server.js"]
