# Automated checks

The HTML files in `test-harness/` are the human-readable fixture pages, and
`test-harness/COMPARISON.md` is the manual Apple-vs-FAPassword worksheet. This `automation/`
directory drives those same fixtures with isolated mock extensions; it does not replace the
manual comparison against Apple's real extension.

`npm test` runs the dependency-free unit suite. It exercises SRP challenge lifecycle,
independent crypto fingerprints/vectors, native-port disconnect handling, and reconnects.

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
