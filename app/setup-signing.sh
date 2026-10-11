#!/bin/sh
# Creates "Jarvis Local Signing", a self-signed code-signing identity in the
# login keychain, once. Signing every build with the same identity keeps
# macOS's permissions (microphone, calendars, automation, screen recording)
# across rebuilds; ad-hoc builds look like a new app to macOS each time.
# Not trusted system-wide and not used for anything but Jarvis.app.
set -eu
name="Jarvis Local Signing"
if security find-identity -p codesigning | grep -q "\"$name\""; then
  echo "$name already exists"
  exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 3650 -config "$tmp/cert.cnf" 2>/dev/null
pass=$(openssl rand -hex 16)
openssl pkcs12 -export -legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$name" -out "$tmp/id.p12" -passout "pass:$pass" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$name" -out "$tmp/id.p12" -passout "pass:$pass"
security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$pass" -T /usr/bin/codesign
echo "created $name"
