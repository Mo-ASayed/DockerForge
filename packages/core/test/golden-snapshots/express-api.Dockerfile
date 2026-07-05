# syntax=docker/dockerfile:1
FROM node:22-alpine3.21

WORKDIR /app

ENV NODE_ENV=production

COPY package-lock.json package.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser

STOPSIGNAL SIGTERM
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node","src/server.js"]
