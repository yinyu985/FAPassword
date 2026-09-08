# Automated checks

The HTML files in `test-harness/` are the human-readable fixture pages, and
`test-harness/COMPARISON.md` is the manual Apple-vs-FAPassword worksheet. This `automation/`
directory drives those same fixtures with isolated mock extensions; it does not replace the
manual comparison against Apple's real extension.

For an explicitly authorized real-vault test, run
`python3 -m http.server 8766 --bind 127.0.0.1 --directory test-harness` from the
project root and open `http://localhost:8766/live-save.html` with the real extension.
Prepare and submit the disposable account, approve Apple's sheet, then independently
find that account under localhost in Apple Passwords. Refresh extension caches, clear
the form, fill that same account, and compare the result using the page's check button.
Repeat with the update button to verify the second password version. Keep the page open:
the generated values exist only in its memory. Page submission and native acknowledgement
alone do not establish vault persistence. Confirm an uncertain result before resubmitting.

`npm test` exercises SRP challenge lifecycle, independent crypto fingerprints/vectors,
native-port disconnect handling, reconnects and build safety. Build tests use the installed esbuild dependency.
`build-safety.test.mjs` checks stale bundles, no-op writes, concurrent reads during replacement,
failed-build preservation and retention of other installed versions, without launching a browser.

`npm run test:e2e` runs the optional browser suite. It builds isolated mock extensions,
starts a local HTTP fixture server, runs every driver, then stops only the server it started.
It does **not** install Playwright or download a browser.

To run browser checks, point the suite at an existing Playwright module if it is not already
installed in your environment:

```bash
FAPASSWORD_PLAYWRIGHT=/path/to/playwright/index.js npm run test:e2e
```

To make Playwright use an existing Chrome/Chromium/Helium binary rather than a bundled one:

```bash
FAPASSWORD_PLAYWRIGHT=/path/to/playwright/index.js \
FAPASSWORD_BROWSER_EXECUTABLE="/Applications/Helium.app/Contents/MacOS/Helium" \
npm run test:e2e
```

Optional environment variables:

- `FAPASSWORD_BASE`: use an already-running fixture server instead of the default local one.
- `FAPASSWORD_PLAYWRIGHT`: path to an existing Playwright module.
- `FAPASSWORD_BROWSER_EXECUTABLE`: existing Chromium-compatible browser executable.

The mock builder opens the suggestion Shadow DOM only in inspectable test builds. The
`privacy` build keeps the production `closed` mode and verifies that page JavaScript cannot
read account names. No real Apple Passwords data, PIN, or Touch ID interaction is used.

Browser coverage includes login/OTP/adversarial classification, targeted fills, input events,
hidden fields, same- and cross-origin frames, multi-account UI, scripted-submit rejection,
and the closed-shadow privacy boundary.

`drive-toolbar.mjs` runs the real Chromium `action.setIcon` API from the production worker
under `src/`, recording API completion and errors instead of mocking image loading. It checks
red startup and pending PIN, incorrect PIN, white restoration only after PIN success at all
icon sizes, session relock, native disconnect and reconnect followed by successful verification.
The test uses a temporary extension/profile and simulated native transport; it does not inspect
the user's pinned toolbar. Run the mock builder before invoking this driver directly.

## Production behavior and artifact tests

The builder now keeps the real background, protocol, SRP, cache and save code. Only native
transport is simulated in `mock-native.js`; it performs the server side of SRP/AES-GCM and
provides controlled delays, status errors and fake entries. Passive message counters record
frame registration and duplicate UI requests. `mock-background.js` has been removed.

`drive-security.mjs` covers document/field races, exact credential identity, save lifecycle,
iframe targeting, PIN state and popup failures. `drive-redress.mjs` retains closed Shadow DOM
and uses real mouse/keyboard events against moved, transparent or covered suggestion hosts.
`drive-visual.mjs` checks both theme contrast palettes and zoom, saving evidence in `shots/`.
`drive-notices.mjs` checks English/Chinese notice typography, spacing and normal/error colors in both themes, empty-state host visibility, error recovery, refused privacy-toggle changes in both directions, generator defaults/options and clipboard feedback using a simulated popup API.
`drive-experience.mjs` checks the account-first inline layout, bottom-right wordmark, invisible
scrollbars with all entries reachable, repeated refresh without replacing account nodes or
changing window height, failure recovery, unavailable documents and restrictive stylesheet CSP.
These behavior requirements are maintained in [`SPEC.md`](../../SPEC.md).
Cross-origin tests require a loaded frame and an actual content-script registration.

To exercise the installable build without rebundling its background code:

```bash
npm run build
FAPASSWORD_BUILD_SOURCE="$PWD/dist/fapassword-0.47.0" npm run test:e2e
```

Set the Playwright/browser variables above as appropriate. Test builds add a native-transport
prelude; the copied artifact's background bytes remain unchanged. Never load test builds for
personal browsing. Test data never reaches the real Apple helper.
Root-directory tests now also copy the actual generated worker without rebundling it; the
builder checks freshness first so it cannot conceal a broken root entry behind a test-only build.

`npm run test:native` tests the Python policy helper using simulated managed preferences and
profiles in temporary directories. On macOS it additionally exercises real CoreFoundation
read-only queries. It never installs policy or accesses Passwords.

All browser contexts use owned directories from `os.tmpdir()` / `mkdtemp`; their wrapper
removes these in `finally`, including setup failure. Tests use `FAPASSWORD_BASE` consistently.
The suite itself does not download prerequisites. CI explicitly installs Playwright 1.42.1
(Chromium 123) and 1.62.1 in a separate tool directory, then tests the built artifact.

Real Apple helper and VoiceOver acceptance remains separate. Record it with the checklist in
[`VERIFICATION.md`](../../VERIFICATION.md); mocked transport is not proof of vault persistence.
