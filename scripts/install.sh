#!/usr/bin/env bash
# OLL-E installer.
#
#   scripts/install.sh [install|update|uninstall|status]
#
# install    — build, place binary at $BIN_DIR/olle, register autostart service
# update     — rebuild, stop daemon, swap binary, restart daemon
# uninstall  — stop + unregister service, remove binary (keeps ~/.olle data)
# status     — show where things live and whether the daemon is running
#
# Defaults: user-local install (no sudo). Override with env vars:
#   BIN_DIR       (default: ~/.local/bin)
#   OLLE_HOME     (default: ~/.olle)
#   OLLE_AUTOSTART (default: 1 — set 0 to skip service registration)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
OLLE_HOME="${OLLE_HOME:-$HOME/.olle}"
OLLE_AUTOSTART="${OLLE_AUTOSTART:-1}"
SERVICE_LABEL="sh.olle.daemon"

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=darwin ;;
  Linux)  PLATFORM=linux ;;
  *) echo "olle: unsupported OS: $OS" >&2; exit 1 ;;
esac

PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/olle.service"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxxx\033[0m %s\n' "$*" >&2; exit 1; }

require_bun() {
  command -v bun >/dev/null 2>&1 || die "bun not found on PATH — install from https://bun.sh"
}

build_binary() {
  require_bun
  log "building olle from $REPO_DIR"
  ( cd "$REPO_DIR" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null )
  [[ -x "$REPO_DIR/dist/olle" ]] || die "build produced no dist/olle"
}

install_binary() {
  mkdir -p "$BIN_DIR"
  install -m 0755 "$REPO_DIR/dist/olle" "$BIN_DIR/olle"
  # macOS: ad-hoc sign + clear quarantine so the kernel doesn't SIGKILL the
  # binary on first run. `bun build --compile` ships an LC_CODE_SIGNATURE
  # load command from its embedded runtime that the appended JS payload
  # invalidates — codesign refuses to overwrite it, so strip it first.
  # Harmless no-ops on Linux.
  if [[ "$PLATFORM" == "darwin" ]]; then
    xattr -d com.apple.quarantine "$BIN_DIR/olle" 2>/dev/null || true
    codesign --remove-signature "$BIN_DIR/olle" 2>/dev/null || true
    if ! codesign --force --sign - "$BIN_DIR/olle"; then
      die "codesign failed on $BIN_DIR/olle — macOS will SIGKILL it on launch"
    fi
  fi
  log "installed $BIN_DIR/olle"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on PATH — add it to your shell rc" ;;
  esac
}

write_launchd_plist() {
  mkdir -p "$(dirname "$PLIST_PATH")" "$OLLE_HOME/logs"
  local env_block=""
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    env_block="  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key>
    <string>$ANTHROPIC_API_KEY</string>
    <key>OLLE_HOME</key>
    <string>$OLLE_HOME</string>
  </dict>"
  else
    env_block="  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLE_HOME</key>
    <string>$OLLE_HOME</string>
  </dict>"
  fi
  cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/olle</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardOutPath</key><string>$OLLE_HOME/logs/daemon.out</string>
  <key>StandardErrorPath</key><string>$OLLE_HOME/logs/daemon.err</string>
  <key>WorkingDirectory</key><string>$HOME</string>
$env_block
</dict>
</plist>
EOF
  log "wrote $PLIST_PATH"
}

write_systemd_unit() {
  mkdir -p "$(dirname "$SYSTEMD_UNIT")" "$OLLE_HOME/logs"
  cat >"$SYSTEMD_UNIT" <<EOF
[Unit]
Description=OLL-E daemon
After=network.target

[Service]
Type=simple
ExecStart=$BIN_DIR/olle run
Environment=OLLE_HOME=$OLLE_HOME
${ANTHROPIC_API_KEY:+Environment=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  log "wrote $SYSTEMD_UNIT"
}

service_load() {
  [[ "$OLLE_AUTOSTART" == "1" ]] || { log "autostart disabled (OLLE_AUTOSTART=0)"; return; }
  case "$PLATFORM" in
    darwin)
      write_launchd_plist
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      launchctl load -w "$PLIST_PATH"
      log "launchd agent loaded"
      ;;
    linux)
      write_systemd_unit
      systemctl --user daemon-reload
      systemctl --user enable --now olle.service
      log "systemd user service enabled + started"
      ;;
  esac
}

service_stop() {
  case "$PLATFORM" in
    darwin)
      [[ -f "$PLIST_PATH" ]] && launchctl unload "$PLIST_PATH" 2>/dev/null || true
      ;;
    linux)
      [[ -f "$SYSTEMD_UNIT" ]] && systemctl --user disable --now olle.service 2>/dev/null || true
      ;;
  esac
}

service_restart() {
  case "$PLATFORM" in
    darwin)
      launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || service_load
      ;;
    linux)
      systemctl --user restart olle.service 2>/dev/null || service_load
      ;;
  esac
}

service_status() {
  case "$PLATFORM" in
    darwin)
      if launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
        echo "service: loaded ($SERVICE_LABEL)"
      else
        echo "service: not loaded"
      fi
      ;;
    linux)
      systemctl --user is-active olle.service 2>/dev/null | sed 's/^/service: /' || echo "service: inactive"
      ;;
  esac
}

daemon_reachable() {
  [[ -x "$BIN_DIR/olle" ]] || return 1
  "$BIN_DIR/olle" status >/dev/null 2>&1
}

cmd_install() {
  build_binary
  install_binary
  service_load
  sleep 1
  if daemon_reachable; then
    log "daemon is up — try: olle status"
  else
    warn "daemon not reachable yet; check $OLLE_HOME/logs/daemon.err"
  fi
}

cmd_update() {
  build_binary
  log "stopping daemon for swap"
  service_stop
  install_binary
  log "starting daemon"
  service_load
  sleep 1
  if daemon_reachable; then
    log "update complete"
  else
    warn "daemon not reachable after update; check $OLLE_HOME/logs/daemon.err"
  fi
}

cmd_uninstall() {
  service_stop
  rm -f "$PLIST_PATH" "$SYSTEMD_UNIT"
  rm -f "$BIN_DIR/olle"
  log "removed binary and service unit"
  log "data dir $OLLE_HOME preserved — rm -rf it manually if you want a clean slate"
}

cmd_status() {
  echo "repo:     $REPO_DIR"
  echo "binary:   $BIN_DIR/olle $([[ -x $BIN_DIR/olle ]] && echo '(present)' || echo '(missing)')"
  echo "data:     $OLLE_HOME"
  service_status
  if daemon_reachable; then
    "$BIN_DIR/olle" status | sed 's/^/  /'
  else
    echo "daemon:   unreachable"
  fi
}

case "${1:-install}" in
  install)   cmd_install ;;
  update)    cmd_update ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  -h|--help|help)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown subcommand: $1 (try install|update|uninstall|status)" ;;
esac
