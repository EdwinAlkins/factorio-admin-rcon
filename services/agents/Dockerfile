# The two agents of the stack, one image each, from this one module:
#
#   control-agent  holds the Docker socket; acts on the Factorio container.
#   data-agent     holds Factorio's saves and mods; never sees the socket.
#
#   docker build --build-arg AGENT=control-agent -t factorio-control-agent .
#   docker build --build-arg AGENT=data-agent    -t factorio-data-agent .
#
# Static Go binary on `distroless/static`: no shell, no libc, no package
# manager. The binary is the only executable in the image, and it doubles as
# its own healthcheck (`/agent -healthcheck`).
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
ARG AGENT=control-agent
ARG TARGETOS TARGETARCH
RUN test -d "./cmd/$AGENT" && \
    GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/agent "./cmd/$AGENT"

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /out/agent /agent
# Numeric uid/gid (65532 = distroless "nonroot"), so runtimes can check it is
# not root without resolving a name. Compose overrides it per agent: the
# control agent adds the Docker socket's group, the data agent runs as the
# Factorio image's uid so the files it writes keep their owner.
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/agent", "-healthcheck"]
ENTRYPOINT ["/agent"]
