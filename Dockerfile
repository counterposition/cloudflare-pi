FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    git \
    ripgrep \
    coreutils \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN mkdir -p /workspace /opt/cloudflare-pi

COPY container/ /opt/cloudflare-pi/

CMD ["sleep", "infinity"]
