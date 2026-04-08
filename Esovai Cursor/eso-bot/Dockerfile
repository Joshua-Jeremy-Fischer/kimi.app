FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV NODE_ENV=production
EXPOSE 3020

CMD ["node", "index.js"]

