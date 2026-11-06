# pump.fun launcher on the TrenchyTools API: Express backend + built Vite frontend in one container.
# Persistent state lives under /data: mount a volume there (Railway: a volume at /data).
#   /data/keys     encrypted vault, settings.json, the generated encryption key
#   /data/data     launches, uploads, vanity pool, live trade history
#   /data/backups  the plaintext wallet backups (the rule: nothing is funded without a file here)
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package-lock.json ./backend/
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --include=dev && npm --prefix backend ci --include=dev && npm --prefix frontend ci --include=dev
COPY backend ./backend
COPY frontend ./frontend
RUN cd backend && npx tsc && cd ../frontend && npx tsc -b && npx vite build --outDir ../backend/public --emptyOutDir

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3101 KEYS_DATA_DIR=/data/keys WALLET_BACKUP_DIR=/data/backups
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/public ./backend/public
EXPOSE 3101
# backend/data is resolved relative to dist/, so point it at the volume before starting
CMD ["sh", "-c", "mkdir -p /data/data /data/keys /data/backups && rm -rf /app/backend/data && ln -s /data/data /app/backend/data && node backend/dist/index.js"]
