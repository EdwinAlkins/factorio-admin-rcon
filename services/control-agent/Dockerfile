# Factorio control agent — the only container of the stack that mounts the
# Docker socket. See README.md next to this file.
#
# Static Go binary on `distroless/static`: no shell, no libc, no package
# manager. The binary is the only executable in the image, and it doubles as
# its own healthcheck (`control-agent -healthcheck`).
#
# Built for the target platform from the build platform (no QEMU emulation):
# Go cross-compiles natively, so a multi-arch build stays fast.

FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine AS builder
WORKDIR /src
# The toolchain in the image is the one go.mod asks for: never download another.
ENV GOTOOLCHAIN=local CGO_ENABLED=0
COPY go.mod ./
RUN go mod download
COPY . .
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/control-agent ./cmd/control-agent

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /out/control-agent /control-agent
# Numeric uid/gid (65532 = distroless "nonroot"), so runtimes can check it is
# not root without resolving a name. Access to the socket comes from the
# Docker group added at run time (`group_add` in docker-compose.yml).
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/control-agent", "-healthcheck"]
ENTRYPOINT ["/control-agent"]
