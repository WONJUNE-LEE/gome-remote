#!/usr/bin/env bash
# Makes the self-signed code-signing certificate for the Mac desktop app and prints the two
# values the release workflow needs as GitHub secrets:
#   MAC_SIGN_P12_BASE64    the PKCS#12 file, base64 on one line
#   MAC_SIGN_P12_PASSWORD  its password
#
# Run it once, on a machine you trust, and keep the .p12 (see --keep) somewhere safe and
# private. Squirrel.Mac installs an update only if it is signed by the same certificate as
# the installed app, so a lost or replaced certificate means every Mac user has to install
# the next version by hand once. Nothing is written inside the repository, and the key
# never leaves the temporary directory unless you pass --keep.
#
#   scripts/make-mac-signing-cert.sh [--keep DIR]
set -euo pipefail

CN="Gome Remote Desktop Signing"
KEEP=""
case "${1-}" in
  "") ;;
  --keep)
    KEEP="${2-}"
    [ -n "$KEEP" ] || { echo "--keep needs a directory" >&2; exit 2; }
    ;;
  *) echo "usage: $0 [--keep DIR]" >&2; exit 2 ;;
esac

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cs.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $CN
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

# 20 years: the certificate must outlive every installed copy of the app.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  -days 7305 -config "$WORK/cs.cnf" 2> /dev/null

PASSWORD="$(openssl rand -hex 24)"
# SHA1/3DES: macOS `security import` cannot read the AES/SHA256 PKCS#12 that OpenSSL 3
# writes by default; LibreSSL (the macOS openssl) accepts these too.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -out "$WORK/id.p12" \
  -passout "pass:$PASSWORD" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1

if [ -n "$KEEP" ]; then
  mkdir -p "$KEEP"
  cp "$WORK/id.p12" "$KEEP/gome-remote-desktop-signing.p12"
  echo "Kept $KEEP/gome-remote-desktop-signing.p12 (password below). Do not commit it." >&2
fi

{
  echo "Certificate: CN=$CN, $(openssl x509 -in "$WORK/cert.pem" -noout -enddate)"
  echo "Set these as repository secrets (Settings > Secrets and variables > Actions):"
} >&2
echo "MAC_SIGN_P12_PASSWORD=$PASSWORD"
echo "MAC_SIGN_P12_BASE64=$(openssl base64 -A -in "$WORK/id.p12")"
