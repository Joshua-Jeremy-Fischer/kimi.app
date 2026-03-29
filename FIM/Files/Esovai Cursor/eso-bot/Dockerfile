FROM node:20-alpine

# bash für shell_exec, git für git_op
RUN apk add --no-cache bash git

WORKDIR /app

# Non-root user
RUN addgroup -g 1001 -S esobot && adduser -S esobot -u 1001 -G esobot

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js agent.js tools.js permissions.js ./

# Workspace-Verzeichnis — Bot arbeitet hier
RUN mkdir -p /workspace && chown esobot:esobot /workspace

USER esobot

EXPOSE 3020

CMD ["node", "index.js"]
