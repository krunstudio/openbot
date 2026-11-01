#!/bin/bash
set -euo pipefail
umask 077

APP_DIR="/opt/openbot-src"
DATA_DIR="${HOME:-/data}"

mkdir -p "$DATA_DIR/.openbot" "$DATA_DIR/wrangler-state" "$DATA_DIR/.config"

# Persist local D1 SQLite, R2 buckets, and generated JWK secrets in /data volume
rm -rf "$APP_DIR/.openbot" "$APP_DIR/apps/auth-api/.wrangler"
ln -s "$DATA_DIR/.openbot" "$APP_DIR/.openbot"
ln -s "$DATA_DIR/wrangler-state" "$APP_DIR/apps/auth-api/.wrangler"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/openbot}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"
rm -f "$XDG_RUNTIME_DIR/control.sock"

MODE="${1:-${OPENBOT_MODE:-app}}"
if [ "$#" -gt 0 ]; then
  shift
fi

if [ "$MODE" = "app" ]; then
  # Start D-Bus session for Electron safeStorage and keyring
  session=$(dbus-launch --sh-syntax)
  eval "$session"

  # Start virtual X11 displays (:0 for OpenBot, :1 for Agent Computer Use)
  rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 /tmp/.X1-lock /tmp/.X11-unix/X1
  DISPLAY_SIZE="${OPENBOT_DISPLAY_SIZE:-1280x800}"
  (Xvfb :0 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &)
  (Xvfb :1 -screen 0 "${DISPLAY_SIZE}x24" -nolisten tcp >/dev/null 2>&1 &)
  export DISPLAY=:0
  export OPENBOT_AGENT_DISPLAY=:1

  for display in :0 :1; do
    for _ in $(seq 1 100); do
      xdpyinfo -display "$display" >/dev/null 2>&1 && break
      sleep 0.1
    done
  done

  # Initialize and unlock gnome-keyring in /data so account sessions persist across restarts
  state="$DATA_DIR/.config/openbot-container"
  keyrings="$DATA_DIR/.local/share/keyrings"
  mkdir -p "$state" "$keyrings"
  if [ ! -s "$state/keyring-password" ]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n' >"$state/keyring-password"
  fi
  printf login >"$keyrings/default"
  unlocked=$(gnome-keyring-daemon --unlock --components=secrets <"$state/keyring-password")
  eval "$unlocked"
  started=$(gnome-keyring-daemon --start --components=secrets)
  eval "$started"
  export GNOME_KEYRING_CONTROL
  export OPENBOT_SERVER=1
  export OPENBOT_SHARED_DEV_PROFILE=1
fi

cd "$APP_DIR"
exec bun scripts/selfhost.ts "$MODE" "$@"
