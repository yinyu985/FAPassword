# Apple iCloud Passwords complaints, and how FAPassword compares

This maps 18 documented complaints about Apple's official iCloud Passwords
Chromium extension to what FAPassword does. "Covered" means a regression exists in
`test-harness/`; dependency-free checks run with `npm test`, while browser checks are optional.
Sources are user reports across the Chrome Web Store, Apple Communities,
Google/Brave forums, GitHub, AppleInsider, and Macworld.

Legend: ✅ fixed · 🟡 partial · ⛔ inherent (no extension can fix)

| # | Complaint | Apple's behavior | FAPassword | Status |
|---|---|---|---|---|
| 1 | Constant re-prompt for the 6-digit code (the top complaint) | re-pairs every restart and often every few hours; resets the session on every capabilities reload | the live native port keeps the worker/session alive; a real disconnect rejects pending work immediately and a later request reconnects cleanly | ✅/⛔ |
| 2 | Verification code never arrives | helper deadlocks; says code generated, none appears | 8s timeout plus a clear error instead of hanging; a broken helper is helper-side | 🟡 |
| 3 | "Failed to verify your identity" | server/helper rejects the browser | helper-side / Apple gating | ⛔ |
| 4 | "Enable AutoFill" balloon on every OTP box and random fields | pops on one-time-code boxes and non-login fields | excludes OTP, search, tags, comments, profile/contact and checkout-address fields; covered by browser fixtures | ✅ |
| 5 | High CPU / typing lag | re-scans the DOM and re-attaches listeners on every keystroke | no per-keystroke work; classification runs on focus, and login-name results have a short per-origin cache | ✅ |
| 6 | Double popups vs Chrome's manager | both managers fight over the field | popup offers opt-in controls for Chromium's competing features; installation changes no browser-wide preference by default | ✅ |
| 7 | Breaks Google Pay / payment autofill | Apple's "disable Chrome autofill" also kills credit-card and address autofill | suppresses only `passwordSavingEnabled`; Chrome's payment and address autofill keep working | ✅ |
| 8 | Two-step (username then password) logins fail | doesn't re-detect the dynamically-shown password field | `autocomplete="username"` plus page-wide password detection handles Google/Microsoft-style two-step. verified in the UI suite | ✅ |
| 9 | Fills, but login fails until you edit a char | programmatic fill doesn't dispatch `input`/`change`, so the page's JS never sees the value | dispatches real `input` and `change` events on every fill. verified: events fire on both fields | ✅ |
| 10 | Subdomain / domain-matching failures | strict exact-host matching | passes the full hostname to the helper, which does Apple's own associated-domain matching | 🟡 |
| 11 | Popup obscures the screen / can't dismiss | overlay z-index and positioning bugs, premature dismissal | the dropdown anchors beside the field, follows scroll/resize, dismisses on outside action, and lives in a closed Shadow DOM | ✅ |
| 12 | "Never save" flag stuck, unclearable off-Mac | no UI to clear it | FAPassword does not create a local never-save list; save/update decisions remain in Apple's native sheet | N/A |
| 13 | Save-new-password auto-saves without consent | aggressive auto-capture | a recent real user submit is required, then Apple's native confirmation sheet remains the write gate; scripted `requestSubmit()` is rejected | ✅ |
| 14 | No Linux support | needs the macOS/Windows helper | same constraint, the helper only exists on macOS/Windows | ⛔ |
| 15 | Touch ID re-prompt friction | re-prompts per fill | the OS controls the biometric gate (`RequiresUserAuthenticationToFill`); can't be removed | ⛔ |
| 16 | Dark-mode toolbar icon can be hard to recognize | the wide black dog/Apple silhouette loses detail at 16 px | original artwork retained; a future 16 px-specific redesign needs a solid high-contrast field and must preserve the dog/Apple shape | 🟡 |
| 17 | Windows version coupling | tied to a specific iCloud-for-Windows build | helper-side | ⛔ |
| 18 | Clickjacking / autofill UI-redressing (Marek Tóth 2025; affects Apple, 1Password, Bitwarden) | autofills into invisible/overlaid fields | requires visible, in-viewport fields plus an explicit user action; delivery is pinned to the exact frame and origin | ✅ |

## What it fixes that Apple doesn't

- the OTP-balloon and false-positive firing (#4): dedicated adversarial fixtures
- frequent re-prompting within a session (#1): live native port plus deterministic reconnect
- the "edit a char to make login work" bug (#9): proper input events
- breaking Google Pay (#7): payment autofill untouched
- typing lag (#5): no per-keystroke work
- clickjacking exfiltration (#18): visibility, intent, and origin checks

## What it can't fix

- Linux (#14), Windows helper coupling (#17), the "unsupported browser" rejection
  (#3), and the helper-side parts of #2 all require Apple's native helper, which no
  extension controls.
- the Touch ID prompt (#15) and the once-per-browser-restart re-pair (#1): the OS
  and the protocol require them, and Apple's extension has them too.

The dependency-free crypto/protocol suite and the optional browser suite are documented in
[`test-harness/automation/README.md`](test-harness/automation/README.md). This file does not
claim a historical pass count as a current result.
