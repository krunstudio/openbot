# syntax=docker/dockerfile:1
# 100% Self-Hosted OpenBot Stack (Control Plane + WebUI /app + Signal + Marketplace + Headless Host)
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG BUN_VERSION=1.4.4
ARG NODE_MAJOR=22

# Install system dependencies for Headless Electron Host, Xvfb, Keyring, Git, and Agent CLI tools
COPY scripts/hosting/packages.txt /tmp/packages.txt
RUN apt-get update \
  && sed -e '/^#/d' -e '/^$/d' -e '/^apparmor$/d' /tmp/packages.txt \
    | xargs apt-get install --yes --no-install-recommends \
      build-essential ca-certificates curl git gnupg less openssh-client \
      procps python3 ripgrep tini unzip xz-utils \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get install --yes --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* /tmp/packages.txt

# Install Bun runtime globally in /usr/local/bin
RUN ARCH="$(dpkg --print-architecture)" \
  && if [ "$ARCH" = "arm64" ]; then BUN_ARCH="aarch64"; else BUN_ARCH="x64"; fi \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" -o /tmp/bun.zip \
  && unzip -q /tmp/bun.zip -d /tmp \
  && install -m 0755 "/tmp/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
  && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
  && rm -rf /tmp/bun.zip "/tmp/bun-linux-${BUN_ARCH}"

# Create non-root openbot user (UID 1000) with /data as persistent home directory
RUN userdel --remove ubuntu 2>/dev/null || true \
  && useradd --uid 1000 --user-group --home-dir /data --create-home --shell /bin/bash openbot \
  && install -d -o openbot -g openbot -m 0700 /run/openbot \
  && install -d -o openbot -g openbot -m 0755 /opt/openbot-src

WORKDIR /opt/openbot-src

# Copy repository and install workspace dependencies
COPY --chown=openbot:openbot . /opt/openbot-src

USER openbot
RUN bun install --frozen-lockfile

# Configure SUID chrome-sandbox and CLI helpers as root
USER root
RUN if [ -f /opt/openbot-src/node_modules/electron/dist/chrome-sandbox ]; then \
      chown root:root /opt/openbot-src/node_modules/electron/dist/chrome-sandbox \
      && chmod 4755 /opt/openbot-src/node_modules/electron/dist/chrome-sandbox; \
    fi \
  && chmod +x /opt/openbot-src/docker/selfhost-entrypoint.sh /opt/openbot-src/selfhost /opt/openbot-src/scripts/hosting/openbot \
  && install -d -m 0755 /opt/OpenBot/hosted \
  && printf 'container\n' >/opt/OpenBot/hosted/mode \
  && ln -sf /opt/openbot-src/scripts/hosting/openbot /usr/local/bin/openbot \
  && ln -sf /opt/openbot-src/selfhost /usr/local/bin/selfhost

ENV LANG=C.UTF-8 \
  HOME=/data \
  XDG_RUNTIME_DIR=/run/openbot \
  OPENBOT_API_HOST=0.0.0.0 \
  OPENBOT_API_PORT=3100 \
  REMOTE_SIGNAL_PORT=3101 \
  CHROME_DEVEL_SANDBOX=/opt/openbot-src/node_modules/electron/dist/chrome-sandbox

USER openbot
WORKDIR /data
VOLUME ["/data"]

# 3100 = WebUI (/app) + Control Plane API + Marketplace
# 3101 = Signal WebSocket Server (/v1/signal)
EXPOSE 3100 3101

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/openbot-src/docker/selfhost-entrypoint.sh"]
CMD ["app"]
