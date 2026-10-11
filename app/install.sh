#!/bin/sh
# Builds Jarvis (Release), signs it with "Jarvis Local Signing" when that
# identity exists (see setup-signing.sh) so macOS keeps its permissions, and
# installs it to ~/Jarvis/Jarvis.app, restarting the running copy.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home="${JARVIS_HOME:-$HOME/Jarvis}"
dd="${TMPDIR:-/tmp}/jarvis-build"
xcodebuild -project "$here/Jarvis.xcodeproj" -scheme Jarvis -configuration Release \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath "$dd" build -quiet
app="$dd/Build/Products/Release/Jarvis.app"
if security find-identity -p codesigning | grep -q '"Jarvis Local Signing"'; then
  codesign --force --deep --sign "Jarvis Local Signing" "$app"
else
  echo "note: no Jarvis Local Signing identity; macOS will ask for permissions again after each install (run setup-signing.sh)"
fi
pkill -TERM -f "Jarvis.app/Contents/MacOS/Jarvis" 2>/dev/null || true
pkill -f "launcher/src/cli.ts warm" 2>/dev/null || true
sleep 1
mkdir -p "$home"
rm -rf "$home/Jarvis.app.new"
cp -R "$app" "$home/Jarvis.app.new"
rm -rf "$home/Jarvis.app"
mv "$home/Jarvis.app.new" "$home/Jarvis.app"
open "$home/Jarvis.app"
echo "installed $home/Jarvis.app"
