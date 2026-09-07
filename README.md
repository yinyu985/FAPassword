<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="FAPassword logo">
</p>

<h1 align="center">FAPassword</h1>

<p align="center">
  A Chromium extension that talks to Apple Passwords (iCloud Keychain) on macOS and autofills your logins, without the official extension's headaches.
</p>

---

Apple's official iCloud Passwords extension for Chrome sits at 2.3 out of 5 across ~2,600 ratings. It forgets your session and re-asks for the 6-digit code every few hours, throws an "Enable AutoFill" balloon on top of one-time-code boxes, and fights Chrome's own password manager. This is a replacement client.

It speaks the same native-messaging protocol Apple's extension uses (`com.apple.passwordmanager`): an SRP-6a handshake where the 6-digit code your Mac shows you is the shared secret, then an AES-GCM encrypted channel for the password queries. Same vault, same OS authorization, with saner client behavior.

It connects to the live vault, prompts for the PIN once, lists the logins for the current site, and fills them.

## Paste-friendly PIN entry

The 6-digit code box accepts a **direct paste**. When your Mac shows the code, grab it with a screen OCR and paste whatever comes out — spaces, dashes, line breaks, full-width digits and stray glyphs are all filtered down to the six digits, and verification starts the moment all six are in. No hunting for keys, no hand-untangling a mangled OCR string.

As long as the OCR got six digits right, pasting `123 456`, `1234 56` or `123.456` all verify as `123456` — you never have to type the code by hand.

## What it fixes

| The complaint about Apple's extension | What this does |
|---|---|
| re-prompts for the 6-digit code every restart, sometimes every few hours | the live native-messaging port keeps the MV3 worker and session alive; a real disconnect is detected and recovered cleanly ([protocol.js](src/protocol.js)) |
| "Enable AutoFill" balloon on every field, including OTP boxes | explicit OTP semantics take precedence over password type; known OTP/search/contact fixtures are excluded, while unlabelled custom widgets remain heuristic ([field-policy.js](src/field-policy.js)) |
| 100% CPU / typing lag | focus triggers classification; typing only dismisses stale offers/cancels pending fills, without a document scan or native query |
| re-downloads every image on hover to scan for QR codes | there's no image or QR scanning here at all |
| fills the wrong field or wrong origin | fills bind the exact origin, frame, document, request and field references; eligibility is rechecked before each write |

You fill two ways: the inline dropdown when you focus a login field, or the toolbar popup. Both run through the same origin-checked, OS-authorized path.

The toolbar popup also has two explicit utilities at the bottom: open Apple Passwords to maintain credentials, and generate a strong password. With the optional native helper installed or updated (`./native/install.sh`), Open Apple Passwords first launches the standalone app and automatically falls back to password settings if launch fails. Without a compatible helper, the button uses the macOS settings link (or Apple's instructions if the OS version is unavailable). The generator lets you choose an 8–64 character length and whether to include special characters. Generated values stay in the popup until you explicitly copy them; they are not sent to the background or persisted. Focusing a new-password field also exposes direct fill options in the inline menu.

## The catch you should know about first

This is a sideload-from-GitHub tool. It can't go on the Chrome Web Store, and the reason is in macOS itself.

macOS 14+ ships a native helper called `PasswordManagerBrowserExtensionHelper`. On macOS 15.4 and later that helper only accepts connections from two hard-coded extension IDs, Apple's own Chrome and Edge extensions. Those IDs are compiled into the signed system binary, and it refuses everything else.

So to connect at all, this extension's `manifest.json` carries the public `key` from Apple's extension, which makes Chrome assign it the one ID the helper accepts: `pejdijmoenmkgeppbflobdenhhabjlaj`. That's the only way a Chrome extension reaches the helper on current macOS.

What that means for you:

- it works when loaded unpacked for personal use
- it can't be published to the Web Store, because that ID and key belong to Apple
- you have to disable Apple's official iCloud Passwords extension first, since two extensions can't share one ID in the same profile

For a publishable browser client, Firefox is the path that works, see [au2001/icloud-passwords-firefox](https://github.com/au2001/icloud-passwords-firefox). Chrome is locked to Apple's IDs.

### Why an own-ID version isn't possible

On macOS 15.4+, reading the live vault needs either Apple's native helper (which demands one of Apple's two IDs) or an Apple-only keychain entitlement. Every other route dead-ends:

| Route | What happened |
|---|---|
| spawn the helper via a proxy native host | killed by the helper's parent launch constraint, the parent has to be a whitelisted browser |
| own extension ID into the helper | rejected, the allowed IDs are hardcoded in the signed binary |
| `security` CLI / `Security.framework` | returns 0 synchronizable items, it can't see the iCloud vault |
| read `keychain-2.db` directly | the SQLite is readable but the password blobs are encrypted, keys gated by Apple-only entitlements |
| Apple's [`password-manager-resources`](https://github.com/apple/password-manager-resources) contribution process | only authorizes browsers by signing identity through OS updates, no path for a third-party extension |

Borrowing Apple's key is the only way in. The evidence is in [VERIFICATION.md](VERIFICATION.md).

## Requirements

- macOS 14 (Sonoma) or later, signed into iCloud with Passwords on
- Chrome, Edge, Chromium, Brave, or Helium (native-helper acceptance can vary by macOS/browser build)
- Apple's official iCloud Passwords extension removed or disabled

## Install

```bash
git clone https://github.com/yinyu985/FAPassword.git
```

1. disable Apple's official iCloud Passwords extension (it claims the same ID)
2. open `chrome://extensions` and turn on Developer mode (top right)
3. click Load unpacked and pick the `FAPassword` folder
4. confirm the ID reads `pejdijmoenmkgeppbflobdenhhabjlaj`
5. click the toolbar icon, type the 6-digit code your Mac shows, done
6. go to a site with a saved login and fill it

### Optional: hide the browser's own password manager

The popup can disable browser password saving through `passwordSavingEnabled`. This API does not promise to disable every password autofill surface. The separate address toggle controls `autofillAddressEnabled`; it does not control payment autofill. See [Chrome's privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy). Disabling the current browser's password manager through macOS managed policy requires the optional helper:

```bash
./native/install.sh   # registers a tiny native helper, macOS only
```

Then fully quit and reopen your browser (`Cmd+Q`). The **Hide browser password manager entirely** toggle builds a configuration profile for the **launching browser only** and opens it for your approval. The UI names that browser. A forced policy counts as disabled only when its actual Boolean value is false; policies for other browsers are ignored. Re-run the installer to update older helper copies. Existing legacy profiles that cover several browsers must be removed manually in System Settings before switching to the scoped profile. The helper accepts messages solely from this extension's ID and only opens Apple Passwords, password settings, that profile or the System Settings profile pane. `./native/uninstall.sh` removes the helper registration; an installed profile must be removed by you in System Settings.

## How it works

```
popup.js / content.js
        │  runtime messages
        ▼
background.js  ──  owns the live native port and rejects stale/disconnected work
        │
        ▼
protocol.js  ──  chrome.runtime.connectNative("com.apple.passwordmanager")
        │            GET_CAPABILITIES → m0 (challenge/PIN) → m2 (verify) → queries
        ▼
srp.js + crypto.js   SRP-6a (RFC 5054, 3072-bit) + AES-GCM session
        ▼
PasswordManagerBrowserExtensionHelper (macOS native, talks to iCloud Keychain)
```

## What it doesn't fix

- the macOS authorization prompt. when the helper reads a password, macOS itself asks for Touch ID or your login password. that's the per-credential `RequiresUserAuthenticationToFill` flag set by the vault. Chrome's built-in manager skips it only because it keeps passwords in its own database instead of the iCloud vault, and removing it would mean giving up live vault access.
- no Linux. same as Apple, the native helper only exists on macOS and Windows.
- no passkey or TOTP management. out of scope, this reads passwords and login names.
- it still rides on Apple's helper. if Apple changes or breaks it, like past macOS updates have, this breaks too.

## Troubleshooting

### Your Mac shows a code, but the extension says it is incorrect

A code belongs to one handshake. The helper ends that handshake as soon as it checks a code, right or wrong. A new handshake puts a new code on screen and ends the old one. The old prompt can stay visible after its code is dead.

Clicking the inline unlock entry requests a fresh code, even if you dismissed the previous system window. The extension popup then reuses that challenge so it does not issue a second code. After a failed attempt, one shared status area explains which code to enter. You can also select **Request a new code** in the popup.

A code expires after 3 minutes. After that, the extension asks your Mac for a new code instead of checking the old one.

### Filling remains stuck after a Touch ID prompt

A password read is allowed up to 2 minutes. If Apple's helper never replies and never disconnects,
FAPassword closes that ambiguous native stream so a late reply cannot be applied to another request.
Select the login again to reconnect. If it repeats, fully quit the browser and reopen it.

### The official Apple extension behaves strangely alongside FAPassword

Do not enable both at once. The native helper requires Apple's accepted extension identity, so the
two extensions collide at the integration boundary and can race for prompts and field handling.

## Security notes

- the session key lives only in the worker's memory and is never written to disk
- every password query is AES-GCM encrypted end to end with the helper
- the PIN only derives the SRP shared key, it isn't stored
- PIN entry stays in the extension popup; account suggestions render in a closed Shadow DOM
- password delivery binds an exact document/request/field and refuses HTTP except explicit loopback hosts (`localhost`, subdomains of `.localhost`, `127.0.0.1`, `[::1]`); `.test` and private-network HTTP hosts are not exceptions
- closed Shadow DOM protects suggestion contents, while top-layer positioning, hit-testing and trusted interaction checks defend the reproduced redressing cases; this is not a proof against all hostile page rendering techniques
- passwords are cached in memory for at most two minutes, with expiry checked on reads; session changes and save handoffs invalidate caches
- reading a password can trigger a Touch ID prompt, that's the helper, not this extension

## Saving and refresh behavior

Refresh updates the account list and invalidates both credential caches. It does not read or fill a password. **Fill again** is a separate explicit action that retains the original login frame.

User submissions are handed to the background immediately. Existing usernames are also offered to Apple's `maybeAdd` flow so that changed passwords can be considered for update. Deferred requests expire after three minutes before handoff. The popup shows waiting, failed, uncertain, expired and sent states with retry/cancel controls. Like Apple's client, saving sends a one-way command; it does not wait for a save reply or block subsequent queries. A successful send proves neither approval nor persistence in the vault. Check Apple Passwords before retrying an uncertain request. Cancelling a local request cannot undo a native operation already received by macOS.

Automated checks use simulated native transport. They do not establish real Touch ID, live-vault or OS/browser compatibility. See [the current verification matrix](VERIFICATION.md) for tested cases and remaining manual acceptance.

## Development

Product behavior, UI hierarchy, scrollbar-free inline suggestions, refresh interaction and security constraints are defined in [SPEC.md](SPEC.md) (Chinese). Tested scope and remaining manual acceptance are recorded separately in [VERIFICATION.md](VERIFICATION.md).

`npm run check` validates JavaScript, shell/Python syntax, locales, and manifest resources.
`npm test` runs protocol/crypto and build-safety regressions using the installed development dependencies.
The root manifest loads the checked-in classic worker `src/background.bundle.js`. After editing
background source modules, run `npm run bundle:background` or `npm run build`; `check` rejects stale bundles.
`npm run build` updates the versioned directory under `dist/` with identical worker bytes,
replaces files atomically and preserves other installed versions. Load that directory or the project root.
Optional browser automation is documented in
[`test-harness/automation/README.md`](test-harness/automation/README.md) and never downloads a browser automatically.

## Credits

The protocol implementation is derived from [au2001/icloud-passwords-firefox](https://github.com/au2001/icloud-passwords-firefox) (Apache-2.0). See [`NOTICE`](./NOTICE).

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

Not affiliated with or endorsed by Apple Inc.
