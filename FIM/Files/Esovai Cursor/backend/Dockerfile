FROM node:20-alpine

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs

COPY package*.json ./
# npm ci bevorzugt (benötigt package-lock.json); fallback: npm install --omit=dev
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server.js scripts/ ./scripts/

# FIM-Hashes beim Build generieren (nur server.js)
RUN node scripts/fim-gen.cjs

USER nodejs
EXPOSE 3010
CMD ["node", "server.js"]
