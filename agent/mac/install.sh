#!/bin/bash
# Installs or updates the Gome Remote Mac agent. Run it in Terminal on the Mac, as the
# logged-in user (not with sudo): it asks for the administrator password itself, only for
# the steps that need it. The same script installs and updates.
#
#   agent/mac/install.sh            operational install: /usr/local/libexec, root-owned
#   agent/mac/install.sh --dev      development install: everything under your home
#                                   directory, no administrator password (spec O4)
#
# Steps (spec D6): build, sign, put the files in place, create the token, load the
# LaunchAgent, and check that the new program answers within 10 seconds; if it does not,
# the previous program is put back.
#
# GOME_SUDO, GOME_ROOT_OWNER, GOME_PREFIX, GOME_AGENT_BIND, GOME_AGENT_GATEWAY and
# GOME_SKIP_BUILD exist for the test suite (test/agent-install.test.js); leave them alone.
set -euo pipefail

DEV=0
for arg in "$@"; do
  if [ "$arg" = --dev ] && [ "$DEV" = 0 ]; then DEV=1; else echo "usage: $0 [--dev]" >&2; exit 2; fi
done

SUDO="${GOME_SUDO-sudo}"
ROOT_OWNER="${GOME_ROOT_OWNER-root:wheel}"
PREFIX="${GOME_PREFIX-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support/Gome Remote Agent"
SIGN_DIR="$SUPPORT/sign"
KEYCHAIN="$SIGN_DIR/agent-sign.keychain-db"
IDENTITY="Gome Remote Agent Signing"
BUNDLE_ID="net.gome.remote-agent"

AS_ROOT=()
OWN=()
CONFIG_DIR=""
if [ "$DEV" = 1 ]; then
  LABEL="net.gome.remote-agent-dev"
  DATA="$SUPPORT Dev"
  BIN="$DATA/bin/gome-remote-agent"
  CONFIG="$DATA/agent.json"
  TOKEN_FILE="$DATA/token"
  LOG="$HOME/Library/Logs/gome-remote-agent-dev.log"
  PORT=18472
  FEATURES=(--features dev-install)
else
  LABEL="net.gome.remote-agent"
  BIN="$PREFIX/usr/local/libexec/gome-remote-agent"
  CONFIG_DIR="$PREFIX/usr/local/etc/gome-remote-agent"
  CONFIG="$CONFIG_DIR/agent.json"
  TOKEN_FILE="$SUPPORT/token"
  LOG="$HOME/Library/Logs/gome-remote-agent.log"
  PORT=18471
  FEATURES=()
  if [ -n "$SUDO" ]; then AS_ROOT=("$SUDO"); fi
  if [ -n "$ROOT_OWNER" ]; then OWN=(-o "${ROOT_OWNER%:*}" -g "${ROOT_OWNER#*:}"); fi
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
root() { ${AS_ROOT[@]+"${AS_ROOT[@]}"} "$@"; }
owner_of() { if [ "$(uname)" = Darwin ]; then stat -f %u "$1"; else stat -c %u "$1"; fi; }
mode_of() { if [ "$(uname)" = Darwin ]; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gome-agent.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# The program and its settings live in directories only an administrator can change; if a
# directory on the way belongs to somebody else, or the administrator group can write to
# it, the whole protection (spec D2) is void.
if [ "$DEV" = 0 ] && [ -z "$PREFIX" ]; then
  for dir in /usr/local /usr/local/libexec /usr/local/etc /usr/local/etc/gome-remote-agent; do
    [ -e "$dir" ] || continue
    if [ "$(owner_of "$dir")" != 0 ]; then
      die "$dir is not owned by root; fix that first (for example: sudo chown root:wheel $dir)"
    fi
    mode="$(mode_of "$dir")"
    case "$mode" in
      *[2367][0-7] | *[0-7][2367]) die "$dir can be written to by others than root (mode $mode); fix that first (for example: sudo chmod go-w $dir)" ;;
    esac
  done
fi

# ---- 1. what is needed from you: asked and checked before anything is built or installed ----
valid_tailnet_ip() {
  local octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  local pattern="^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.$octet\\.$octet\$"
  [[ "$1" =~ $pattern ]]
}
ask() { # ask VARNAME "prompt" [default]
  local name="$1" prompt="$2" default="${3-}" value
  value="${!name-}"
  if [ -z "$value" ]; then
    read -r -p "$prompt${default:+ [$default]}: " value || value=""
    value="${value:-$default}"
  fi
  printf '%s' "$value"
}

# The settings file is only created on the first install; later updates leave it alone.
FIRST_INSTALL=0
if [ ! -f "$CONFIG" ]; then
  FIRST_INSTALL=1
  SUGGESTION=""
  for tool in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if command -v "$tool" > /dev/null 2>&1; then
      SUGGESTION="$("$tool" ip -4 2> /dev/null | head -1 || true)"
      break
    fi
  done
  BIND="$(ask GOME_AGENT_BIND "This Mac's Tailscale IPv4 address" "$SUGGESTION")"
  GATEWAY="$(ask GOME_AGENT_GATEWAY "The gateway server's Tailscale IPv4 address")"
  valid_tailnet_ip "$BIND" || die "'$BIND' is not a Tailscale IPv4 address (100.64.x.x to 100.127.x.x)"
  valid_tailnet_ip "$GATEWAY" || die "'$GATEWAY' is not a Tailscale IPv4 address (100.64.x.x to 100.127.x.x)"
else
  BIND="$(sed -n 's/.*"bind"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
  PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$CONFIG" | head -1)"
  PORT="${PORT:-18471}"
  [ -n "$BIND" ] || die "$CONFIG has no \"bind\" address"
fi

# ---- 2. build ----
if [ -z "${GOME_SKIP_BUILD-}" ]; then
  if [ -d "$HOME/.cargo/bin" ]; then export PATH="$HOME/.cargo/bin:$PATH"; fi
  say "Building (release, locked)..."
  (cd "$HERE" && cargo build --release --locked ${FEATURES[@]+"${FEATURES[@]}"})
fi
BUILT="$HERE/target/release/gome-remote-agent"
[ -f "$BUILT" ] || die "the build produced no $BUILT"

# ---- 3. sign: a self-signed code-signing certificate in a keychain of its own, hardened runtime ----
make_identity() {
  if [ -f "$KEYCHAIN" ] && security find-identity -p codesigning "$KEYCHAIN" 2> /dev/null | grep -q "$IDENTITY"; then
    return 0
  fi
  say "Creating the signing identity (once)..."
  mkdir -p "$SIGN_DIR"
  chmod 700 "$SUPPORT" "$SIGN_DIR"
  local work="$WORK/identity"
  mkdir "$work"
  local password_file="$SIGN_DIR/keychain-password"
  if [ ! -f "$password_file" ]; then (umask 077; head -c 24 /dev/urandom | base64 > "$password_file"); fi
  local password
  password="$(cat "$password_file")"
  cat > "$work/cs.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 3650 -config "$work/cs.cnf" 2> /dev/null
  openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/id.p12" -passout pass:gome
  rm -f "$KEYCHAIN"
  security create-keychain -p "$password" "$KEYCHAIN"
  security set-keychain-settings "$KEYCHAIN"
  security unlock-keychain -p "$password" "$KEYCHAIN"
  security import "$work/id.p12" -k "$KEYCHAIN" -P gome -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$KEYCHAIN" > /dev/null
  rm -rf "$work"
}
make_identity
security unlock-keychain -p "$(cat "$SIGN_DIR/keychain-password")" "$KEYCHAIN"
SIGNED="$WORK/gome-remote-agent"
cp "$BUILT" "$SIGNED"
codesign --force --options runtime --keychain "$KEYCHAIN" -s "$IDENTITY" -i "$BUNDLE_ID" "$SIGNED"
codesign --verify --strict "$SIGNED"

# ---- 4. put the files in place ----
# The new program is written next to the old one and renamed over it: a program that is
# running keeps its own file, and macOS never sees a signed file rewritten in place.
FRESH=0
[ -f "$BIN" ] || FRESH=1
if [ "$DEV" = 1 ]; then
  mkdir -p "$DATA/bin"
  chmod 700 "$DATA"
  if [ -f "$BIN" ]; then cp -p "$BIN" "$BIN.prev"; fi
  install -m 755 "$SIGNED" "$BIN.new"
  mv -f "$BIN.new" "$BIN"
else
  if [ -n "$SUDO" ]; then say "The administrator password is needed to write under /usr/local."; root -v; fi
  root mkdir -p "$(dirname "$BIN")" "$CONFIG_DIR"
  if [ -f "$BIN" ]; then root cp -p "$BIN" "$BIN.prev"; fi
  root install ${OWN[@]+"${OWN[@]}"} -m 755 "$SIGNED" "$BIN.new"
  root mv -f "$BIN.new" "$BIN"
fi

if [ "$FIRST_INSTALL" = 1 ]; then
  json="$(printf '{\n  "bind": "%s",\n  "port": %s,\n  "gateway": "%s"\n}\n' "$BIND" "$PORT" "$GATEWAY")"
  printf '%s\n' "$json" > "$WORK/agent.json"
  if [ "$DEV" = 1 ]; then
    install -m 644 "$WORK/agent.json" "$CONFIG"
  else
    root install ${OWN[@]+"${OWN[@]}"} -m 644 "$WORK/agent.json" "$CONFIG"
  fi
fi

# ---- 5. the token: 32 random bytes, base64url, created once ----
NEW_TOKEN=0
if [ ! -f "$TOKEN_FILE" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  chmod 700 "$(dirname "$TOKEN_FILE")"
  (umask 077; openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$TOKEN_FILE")
  chmod 600 "$TOKEN_FILE"
  NEW_TOKEN=1
fi

# ---- 6. the LaunchAgent: starts at login and is started again if it ever stops ----
# Standard output and error go to one file: the agent caps the log through its standard
# output, and its refusals to start are written to standard error.
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$BIN</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>$LOG</string>
<key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
plutil -lint "$PLIST" > /dev/null

stop_agent() {
  local i
  launchctl bootout "$DOMAIN/$LABEL" 2> /dev/null || true
  # bootout returns before the job is gone; bootstrap would then fail.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1 || return 0
    sleep 1
  done
}
restart() {
  stop_agent
  launchctl bootstrap "$DOMAIN" "$PLIST"
}

# ---- 7. start it and wait up to 10 seconds for an answer ----
# The agent only talks to the gateway, so from this Mac the answer is a refusal (403) or a
# request for the token (401); either proves that the program started, passed its startup
# checks and is serving. Anything else, or silence, means the new program does not work.
answers() {
  local code
  code="$(curl -s -o /dev/null --connect-timeout 1 -m 1 -w '%{http_code}' "http://$BIND:$PORT/v1/status" || true)"
  [ "$code" = 401 ] || [ "$code" = 403 ] || [ "$code" = 200 ]
}
wait_for_answer() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    answers && return 0
    sleep 1
  done
  return 1
}
restart
if ! wait_for_answer; then
  say "The new agent did not answer within 10 seconds. Log:"
  tail -n 15 "$LOG" 2> /dev/null || true
  if [ -f "$BIN.prev" ]; then
    say "Putting the previous version back..."
    root cp -p "$BIN.prev" "$BIN.new"
    root mv -f "$BIN.new" "$BIN"
    restart
    if wait_for_answer; then die "the new version failed and was rolled back; the previous version is running again"; fi
    die "the new version failed, and the previous version did not answer either"
  fi
  # Nothing to go back to: stop it so it does not keep restarting, and make the next run a fresh install.
  stop_agent
  root rm -f "$BIN"
  die "the agent did not start and there is no previous version to go back to (settings and token were kept)"
fi
say "The agent is running ($LABEL, $BIND:$PORT)."

# ---- 8. what is left for a person to do ----
if [ "$FRESH" = 1 ] || [ "$NEW_TOKEN" = 1 ]; then
  cat <<EOF

Next steps (first installation):
  1. System Settings > Privacy & Security: allow "gome-remote-agent" under both
     "Screen & System Audio Recording" and "Accessibility" (add it with "+" if it is
     not listed; the file is $BIN).
  2. Restart the agent so it sees the permissions:
       launchctl kickstart -k $DOMAIN/$LABEL
  3. On the gateway server run:
       node scripts/set-credential.mjs <target-id> --agent-token
     and paste this token (it is shown only now; it stays in $TOKEN_FILE):

$(cat "$TOKEN_FILE")

EOF
fi
