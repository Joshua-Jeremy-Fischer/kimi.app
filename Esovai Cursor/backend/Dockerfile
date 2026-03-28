FROM node:20-alpine

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs

COPY package*.json ./
# npm ci bevorzugt (benötigt package-lock.json); fallback: npm install --omit=dev
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server.js ./

# FIM-Hashes beim Build generieren (nur server.js)
RUN node -e "
const crypto = require('crypto');
const fs = require('fs');
const files = ['server.js'];
const hashes = {};
for (const f of files) {
  hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}
fs.writeFileSync('.fim_hashes.json', JSON.stringify(hashes, null, 2));
console.log('FIM hashes generated:', JSON.stringify(hashes, null, 2));
"

USER nodejs
EXPOSE 3010
CMD ["node", "server.js"]
