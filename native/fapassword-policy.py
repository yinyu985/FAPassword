#!/usr/bin/python3
# Passwords launcher and current-browser managed-policy helper. Existing profiles are not silently
# replaced or removed; System Settings remains the approval/removal interface.
import ctypes
import json
import os
import platform
import plistlib
import struct
import subprocess
import sys
import uuid

BUNDLES = {
    "com.google.Chrome": "Google Chrome", "com.google.Chrome.beta": "Chrome Beta",
    "com.google.Chrome.dev": "Chrome Dev", "com.google.Chrome.canary": "Chrome Canary",
    "com.brave.Browser": "Brave", "com.brave.Browser.origin": "Brave Origin",
    "com.brave.Browser.beta": "Brave Beta", "com.brave.Browser.nightly": "Brave Nightly",
    "com.brave.Browser.dev": "Brave Dev", "com.microsoft.EdgeMac": "Microsoft Edge",
    "org.chromium.Chromium": "Chromium", "net.imput.helium": "Helium",
}
KEY = "PasswordManagerEnabled"
APPDIR = os.path.expanduser("~/Library/Application Support/FAPassword")
_CF = None


def core_foundation():
    global _CF
    if _CF is not None:
        return _CF
    cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFPreferencesAppValueIsForced.restype = ctypes.c_bool
    cf.CFPreferencesAppValueIsForced.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cf.CFPreferencesGetAppBooleanValue.restype = ctypes.c_bool
    cf.CFPreferencesGetAppBooleanValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_bool)]
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    _CF = cf
    return cf


def current_browser():
    """Derive scope from the launching process, never from a caller-selected bundle."""
    pid = os.getppid()
    for _ in range(6):
        command = subprocess.check_output(["/bin/ps", "-p", str(pid), "-o", "comm="], text=True).strip()
        if ".app/" in command:
            app = command.split(".app/", 1)[0] + ".app"
            try:
                with open(os.path.join(app, "Contents", "Info.plist"), "rb") as source:
                    bundle = plistlib.load(source).get("CFBundleIdentifier")
                if bundle in BUNDLES:
                    return bundle
            except (OSError, ValueError):
                pass
        pid = int(subprocess.check_output(["/bin/ps", "-p", str(pid), "-o", "ppid="], text=True).strip())
        if pid <= 1:
            break
    raise RuntimeError("Could not identify the launching browser; reinstall the helper and retry")


def read_policy(bundle):
    if bundle not in BUNDLES:
        raise ValueError("unsupported browser")
    cf = core_foundation()
    key = cf.CFStringCreateWithCString(None, KEY.encode(), 0x08000100)
    app = cf.CFStringCreateWithCString(None, bundle.encode(), 0x08000100)
    try:
        valid = ctypes.c_bool(False)
        value = bool(cf.CFPreferencesGetAppBooleanValue(key, app, ctypes.byref(valid)))
        forced = bool(cf.CFPreferencesAppValueIsForced(key, app))
        value = value if valid.value else None
        return {"hidden": forced and value is False, "managed": forced, "value": value,
                "controlSource": "managed" if forced else "user", "browser": bundle,
                "browserName": BUNDLES[bundle], "scopeVersion": 2}
    finally:
        cf.CFRelease(key)
        cf.CFRelease(app)


def profile_data(bundle):
    if bundle not in BUNDLES:
        raise ValueError("unsupported browser")
    identifier = "com.fapassword.hidepm." + bundle
    return {
        "PayloadType": "Configuration",
        "PayloadDisplayName": "FAPassword - Hide Password Manager - " + BUNDLES[bundle],
        "PayloadDescription": "Disables the built-in password manager only in " + BUNDLES[bundle] + ".",
        "PayloadIdentifier": identifier,
        "PayloadUUID": str(uuid.uuid5(uuid.NAMESPACE_DNS, identifier)).upper(),
        "PayloadVersion": 1, "PayloadRemovalDisallowed": False,
        "PayloadContent": [{"PayloadType": bundle, "PayloadIdentifier": identifier + ".policy",
                            "PayloadUUID": str(uuid.uuid5(uuid.NAMESPACE_DNS, identifier + ".policy")).upper(),
                            "PayloadEnabled": True, "PayloadVersion": 1, KEY: False}],
    }


def write_profile(bundle):
    profile = os.path.join(APPDIR, "FAPassword-HidePasswordManager-" + bundle + ".mobileconfig")
    os.makedirs(APPDIR, exist_ok=True)
    with open(profile, "wb") as target:
        plistlib.dump(profile_data(bundle), target)
    return profile


def open_passwords():
    # Fixed targets only: never accept executable names, paths or URLs from callers.
    try:
        subprocess.run(["/usr/bin/open", "-b", "com.apple.Passwords"], check=True, timeout=10)
        return {"ok": True, "target": "app"}
    except (OSError, subprocess.SubprocessError):
        major = int(platform.mac_ver()[0].split(".")[0])
        pane = "com.apple.Passwords" if major >= 15 else "com.apple.Passwords-Settings.extension"
        subprocess.run(["/usr/bin/open", "x-apple.systempreferences:" + pane], check=True, timeout=10)
        return {"ok": True, "target": "settings"}


def handle(action, bundle):
    if action == "passwordsCapabilities":
        return {"ok": True, "canOpenPasswords": True}
    if action == "openPasswords":
        return open_passwords()
    if action == "set":
        subprocess.run(["/usr/bin/open", write_profile(bundle)], check=True)
    elif action == "clear":
        subprocess.run(["/usr/bin/open", "x-apple.systempreferences:com.apple.preferences.configurationprofiles"], check=True)
    elif action != "get":
        return {"ok": False, "error": "unknown action"}
    return {"ok": True, **read_policy(bundle)}


def send(obj):
    encoded = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)) + encoded)
    sys.stdout.buffer.flush()


def main():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return
    (length,) = struct.unpack("<I", raw)
    try:
        message = json.loads(sys.stdin.buffer.read(length))
        send(handle(message.get("action"), current_browser()))
    except Exception as error:
        send({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
