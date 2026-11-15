# Whale Table - production image
# Zero dependencies: no npm install needed
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY style.css ./
COPY game.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
