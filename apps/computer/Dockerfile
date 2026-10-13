# Two stages, so the result carries the static binary and nothing that built it. Both bases
# are pinned by digest: a tag is mutable, and this image runs commands on someone's machine.
# The digests are multi-arch indexes, so arm64 still builds.
FROM golang:1.23@sha256:60deed95d3888cc5e4d9ff8a10c54e5edc008c6ae3fba6187be6fb592e19e8c0 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=0.0.0-docker
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false
RUN go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/agentum-computer ./cmd/agentum-computer

# busybox rather than distroless: exec runs `sh -c`, so the image needs a shell.
FROM busybox:1.37@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0
# Without a trust store the client cannot verify the server's certificate, and it retries
# forever with textbook backoff, which looks like a network problem and is not.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/agentum-computer /usr/local/bin/agentum-computer

RUN adduser -D -u 1000 agentum \
  && mkdir -p /var/lib/agentum-computer \
  && chown 1000:1000 /var/lib/agentum-computer

USER 1000:1000
# HOME points at /tmp so a read-only rootfs with a tmpfs on /tmp still works.
ENV HOME=/tmp \
    AGENTUM_STATE_DIR=/var/lib/agentum-computer
VOLUME ["/var/lib/agentum-computer"]

# `run` is part of the entrypoint so the copyable command is just --url and --code.
ENTRYPOINT ["/usr/local/bin/agentum-computer", "run"]
