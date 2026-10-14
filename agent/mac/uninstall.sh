#!/bin/bash
# Removes the Gome Remote Mac agent: the LaunchAgent, the program, its settings, the
# token, the log and the signing keychain. Run it in Terminal as the logged-in user; it
# asks for the administrator password for the files under /usr/local.
#
#   agent/mac/uninstall.sh         remove the operational install
#   agent/mac/uninstall.sh --dev   remove the development install
#   add --yes to skip the question
#
# It cannot remove the entries in System Settings > Privacy & Security; it tells you to.
#
# GOME_SUDO and GOME_PREFIX exist for the test suite; leave them alone.
set -euo pipefail

DEV=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --yes) YES=1 ;;
    *) echo "usage: $0 [--dev] [--yes]" >&2; exit 2 ;;
  esac
done

SUDO="${GOME_SUDO-sudo}"
PREFIX="${GOME_PREFIX-}"
SUPPORT="$HOME/Library/Application Support/Gome Remote Agent"
AS_ROOT=()
if [ "$DEV" = 0 ] && [ -n "$SUDO" ]; then AS_ROOT=("$SUDO"); fi
root() { ${AS_ROOT[@]+"${AS_ROOT[@]}"} "$@"; }

if [ "$DEV" = 1 ]; then
  LABEL="net.gome.remote-agent-dev"
  LOG="$HOME/Library/Logs/gome-remote-agent-dev.log"
else
  LABEL="net.gome.remote-agent"
  LOG="$HOME/Library/Logs/gome-remote-agent.log"
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$YES" = 0 ]; then
  read -r -p "Remove the Gome Remote Mac agent ($LABEL) and its files? [y/N] " answer || answer=""
  case "$answer" in y | Y | yes) ;; *) echo "Nothing was removed."; exit 0 ;; esac
fi

# The signing keychain is shared by both installs. Whichever install is removed last takes
# it away (a new one would sign with a different certificate, and macOS would ask for the
# permissions again).
remove_keychain() {
  security delete-keychain "$SUPPORT/sign/agent-sign.keychain-db" 2> /dev/null || true
  rm -rf "$SUPPORT/sign"
  rmdir "$SUPPORT" 2> /dev/null || true
}

launchctl bootout "gui/$(id -u)/$LABEL" 2> /dev/null || true
rm -f "$PLIST" "$LOG"
if [ "$DEV" = 1 ]; then
  rm -rf "$SUPPORT Dev"
  if [ ! -e "$HOME/Library/LaunchAgents/net.gome.remote-agent.plist" ] && [ ! -e "$SUPPORT/token" ]; then
    remove_keychain
  fi
else
  root rm -f "$PREFIX/usr/local/libexec/gome-remote-agent" "$PREFIX/usr/local/libexec/gome-remote-agent.prev"
  root rm -rf "$PREFIX/usr/local/etc/gome-remote-agent"
  rm -f "$SUPPORT/token"
  if [ ! -e "$HOME/Library/LaunchAgents/net.gome.remote-agent-dev.plist" ]; then
    remove_keychain
  fi
fi

cat <<EOF
Removed. One thing is left for you: open System Settings > Privacy & Security, and under
"Screen & System Audio Recording" and "Accessibility" remove the "gome-remote-agent" entries
(select it, then press "-"). macOS does not let a program do that for you.
EOF
