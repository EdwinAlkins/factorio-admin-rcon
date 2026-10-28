# The three agents of the stack, one image each, from this one module:
#
#   control-agent  holds the Docker socket; acts on the Factorio container.
#   data-agent     holds Factorio's saves and mods; never sees the socket.
#   world-agent    runs the game's binary to preview and generate worlds.
#
#   docker build --build-arg AGENT=control-agent -t factorio-control-agent .
#   docker build --build-arg AGENT=data-agent    -t factorio-data-agent .
#   docker build --build-arg AGENT=world-agent --target world-agent -t factorio-world-agent .
#
# The first two: a static Go binary on `distroless/static` — no shell, no
# libc, no package manager. The binary is the only executable in the image,
# and it doubles as its own healthcheck (`/agent -healthcheck`).
#
# The world agent needs the game itself, so it is built on the server's own
# image (FACTORIO_IMAGE, the same tag the server runs: a preview from another
# version may not match the map). That image has a shell and a libc; Compose
# makes up for it with a read-only root, no capability and no network out.
#
# Built for the target platform from the build platform (no QEMU emulation):
# Go cross-compiles natively, so a multi-arch build stays fast.

ARG FACTORIO_IMAGE=factoriotools/factorio:stable

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

# Before the default stage below, so a build without --target still gives a
# distroless agent.
FROM ${FACTORIO_IMAGE} AS world-agent
COPY --from=builder /out/agent /agent
# The factoriotools uid: the worlds it writes keep the owner the data agent
# and the server expect.
USER 845:845
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/agent", "-healthcheck"]
# Replaces the image's own entrypoint, which would start a server.
ENTRYPOINT ["/agent"]
CMD []

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
