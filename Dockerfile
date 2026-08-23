FROM node:20-alpine

# better-sqlite3 braucht Build-Tools zum Kompilieren des nativen Moduls
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY spotifyResolver.js ./
COPY tiktokResolver.js ./
COPY instagramResolver.js ./
COPY public ./public

# Datenverzeichnis für die SQLite-Datei (per Volume persistent machen)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3003
EXPOSE 3003

CMD ["node", "server.js"]
