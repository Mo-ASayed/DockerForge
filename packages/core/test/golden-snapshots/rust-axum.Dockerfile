# syntax=docker/dockerfile:1
# --- Stage 1: Build ---------------------------------------
FROM rust:1.83-slim-bookworm AS build
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked --bin axum-api && \
    cp target/release/axum-api /out-axum-api

# --- Stage 2: Runtime -------------------------------------
FROM debian:bookworm-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install --no-install-recommends -y ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system appgroup && \
    useradd --system --gid appgroup --home-dir /app appuser

COPY --from=build /out-axum-api /usr/local/bin/axum-api

USER appuser
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/axum-api"]
