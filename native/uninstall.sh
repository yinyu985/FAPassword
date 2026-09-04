#!/bin/sh
# Removes the native host registration and its local helper copy. macOS configuration
# profiles cannot be removed by this script; remove "FAPassword - Hide Browser Password
# Manager" in System Settings > General > Device Management to restore the managed policy.
set -e
SUPPORT="$HOME/Library/Application Support"
# every chrome/edge/chromium dir plus every BraveSoftware/* variant
for d in "$SUPPORT/Google/Chrome"* "$SUPPORT/Microsoft Edge" "$SUPPORT/Chromium" "$SUPPORT/net.imput.helium" "$SUPPORT/BraveSoftware/"*/; do
  rm -f "${d%/}/NativeMessagingHosts/com.fapassword.policy.json" 2>/dev/null || true
done
# Remove only files this installer creates; leave an unexpected non-empty directory alone.
rm -f "$SUPPORT/FAPassword/fapassword-policy.py" "$SUPPORT/FAPassword/FAPassword-HidePasswordManager.mobileconfig"
rmdir "$SUPPORT/FAPassword" 2>/dev/null || true
echo "Removed the FAPassword helper. If its configuration profile is installed, remove it in System Settings > General > Device Management, then restart your browser."
