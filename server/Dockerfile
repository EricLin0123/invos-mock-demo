# server/Dockerfile — container image for the Fastify ingestion service.
#
# Build from the REPO ROOT (not server/) so the image can also carry db/migrations,
# which the migrate Job needs:
#
#   docker build -f server/Dockerfile -t invos-ingest:dev .
#
# The same image serves three roles, selected by the container `command`:
#   - the ingest Deployment        -> default CMD (node src/server.js)
#   - the migrate Job              -> node scripts/migrate.js
#   - future CronJobs (lottery...) -> node scripts/<job>.js
#
# Layout inside the image mirrors the repo so migrate.js's relative path
# (server/scripts -> ../../db/migrations) still resolves:
#   /app/server/...   and   /app/db/migrations/...
FROM node:20-slim

WORKDIR /app/server

# Install production deps first for better layer caching.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# App source and the SQL migrations the migrate Job applies.
COPY server/ ./
COPY db/ /app/db/

ENV NODE_ENV=production \
    PORT=8473 \
    HOST=0.0.0.0
EXPOSE 8473

CMD ["node", "src/server.js"]
