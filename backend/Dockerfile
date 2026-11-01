# syntax=docker/dockerfile:1
FROM rust:latest AS builder

WORKDIR /usr/src/nexa-messenger-server
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations

RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /usr/src/nexa-messenger-server/target/release/nexa-messenger-server /app/nexa-messenger-server
COPY migrations /app/migrations
COPY .env.example /app/.env.example

ENV RUST_LOG=info
EXPOSE 10000
EXPOSE 7443

ENTRYPOINT ["/app/nexa-messenger-server"]
