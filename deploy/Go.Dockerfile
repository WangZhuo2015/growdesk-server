# syntax=docker/dockerfile:1
FROM golang:1.27.1-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bin/growdesk-api ./cmd/growdesk-api
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bin/growdesk-worker ./cmd/growdesk-worker
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bin/growdesk-scheduler ./cmd/growdesk-scheduler
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bin/growdesk-migrate ./cmd/growdesk-migrate

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10001 -m -s /bin/false growdesk
USER growdesk
COPY --from=builder /bin/growdesk-api /usr/local/bin/growdesk-api
COPY --from=builder /bin/growdesk-worker /usr/local/bin/growdesk-worker
COPY --from=builder /bin/growdesk-scheduler /usr/local/bin/growdesk-scheduler
COPY --from=builder /bin/growdesk-migrate /usr/local/bin/growdesk-migrate
EXPOSE 3081
ENTRYPOINT ["/usr/local/bin/growdesk-api"]
