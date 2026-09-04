#!/bin/sh
# registers the "hide password manager" policy helper as a native messaging host for every
# chromium browser found (incl brave Origin/Beta). run once after cloning. macOS only
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="pejdijmoenmkgeppbflobdenhhabjlaj" # the ID our manifest key forces
SUPPORT="$HOME/Library/Application Support"

# copy the helper OUTSIDE the repo so moving it wont break the host path, and out of
# ~/Downloads where TCC can stop the browser launching it. Application Support has no gate
APPDIR="$SUPPORT/FAPassword"
mkdir -p "$APPDIR"
cp "$DIR/fapassword-policy.py" "$APPDIR/fapassword-policy.py"
chmod +x "$APPDIR/fapassword-policy.py"
HELPER="$APPDIR/fapassword-policy.py"

# collect the support dir of every installed chromium browser: a fixed set for chrome/edge/
# chromium, and every BraveSoftware/* variant (Brave-Browser, Brave-Origin, -Beta, ...)
found=0
register() {
  d="$1/NativeMessagingHosts"
  mkdir -p "$d"
  cat > "$d/com.fapassword.policy.json" <<EOF
{
  "name": "com.fapassword.policy",
  "description": "FAPassword policy helper",
  "path": "$HELPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "  registered: $(basename "$1")"
  found=$((found + 1))
}

for b in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Dev" "Google/Chrome Canary" "Microsoft Edge" "Chromium" "net.imput.helium"; do
  [ -d "$SUPPORT/$b" ] && register "$SUPPORT/$b"
done
for d in "$SUPPORT/BraveSoftware/"*/; do
  [ -d "$d" ] && register "${d%/}"
done

echo
echo "Helper installed to $HELPER ($found browser(s))"
echo "Now FULLY QUIT and reopen your browser (Cmd+Q), then use the popup toggle."
