# syntax=docker/dockerfile:1
# --- Stage 1: Build ---------------------------------------
FROM golang:1.23-alpine3.21 AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN \
    go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# --- Stage 2: Runtime -------------------------------------
FROM alpine:3.21
WORKDIR /app

RUN apk add --no-cache ca-certificates && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=build /out/api /usr/local/bin/api

USER appuser
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
