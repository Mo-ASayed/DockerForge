# syntax=docker/dockerfile:1
# --- Stage 1: Build ---------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine3.21 AS builder

WORKDIR /app

COPY package-lock.json package.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# --- Stage 2: Runtime -------------------------------------
FROM node:22-alpine3.21

WORKDIR /app

ENV NODE_ENV=production

COPY package-lock.json package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser

STOPSIGNAL SIGTERM
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node","dist/server.js"]
