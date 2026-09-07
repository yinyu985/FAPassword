# Changelog

## Unreleased — audit remediation, 2026-09-07

- Open Apple Passwords through the optional native helper: try the standalone app first and automatically fall back to the appropriate password settings pane if launch fails. Older or absent helpers retain the browser settings link; reinstall the helper to enable direct app launch.
- Keep the toolbar-icon background red until Apple Passwords is successfully unlocked, including startup, retries, waiting for PIN, verification errors, session relock, connection failures and unavailable helpers. Only an unlocked session restores the original white artwork. Localize hover status and guard against stale asynchronous icon updates.
- Fix white-icon restoration from the background worker under `src/` by using extension-root resource URLs. Add a real Chromium action-API regression for startup, unlock, disconnect and reconnect; mocked icon calls missed the failed relative-path fetch.
- Match Apple's one-way native save handoff: do not wait for a reply or disconnect its confirmation sheet on an invented deadline. Preserve the site's port and use the ordinary-login save QID and serialized payload. Test absent/late replies, subsequent queries and ambiguous post failures. Add a localhost manual save/update/readback fixture; real vault persistence remains separate acceptance.
- Route the password-opening action by actual macOS version, using the modern settings bridge or Apple's instructions where appropriate; do not report an unverified app launch as success.

- Consolidate popup operation notices below the active view, including unsupported-page and empty-list states; collapse empty notices without reserving space. Remove Unlock's bottom shadow and match inline account Fill buttons to the popup. Use 128-bit getRandomValues IDs so HTTP content scripts can start without randomUUID, keeping credential origin restrictions intact.
- Add popup actions to open macOS Apple Passwords settings through a user-triggered system deep link and generate a cryptographically random password with explicit copy; generated values remain transient and are never persisted.
- Tighten the Browser controls layout: remove the count badge and focus ring, use a dropdown marker, keep settings and helper notes on one line, and expose password length and special-character choices in the generator.
- Keep the popup at 350px and shorten English/Chinese settings labels and helper notes; retain full text and actionable instructions without clipping or ellipses.
- Request a fresh code before the inline-unlock popup handoff, even when an old challenge remains cached; distinguish newly issued and reused challenges. Put PIN and Unlock on one row with one border and a single status area.
- Restore a generated classic worker for root-directory installations; verify bundle freshness and share its bytes with dist. Build via atomic replacement without deleting loaded directories or rewriting unchanged files.
- Reduce the inline brand footer to about 17px and separate it from accounts with a stronger top border and distinct theme backgrounds; record both requirements in SPEC.md.
- Lead inline suggestions with accounts, hide scrollbars while retaining wheel/keyboard access, and move the plain FAPassword wordmark to a separate bottom-right footer.
- Keep popup rows and layout stable across repeated refreshes, serialize UI operations, and allow account queries without requiring a fillable page document.
- Define project behavior and design constraints in SPEC.md; add repeated-refresh, long-list and restrictive-CSP browser regressions.
- Bind fills to document, request, selected form and field references; revalidate each write and defend the reproduced closed-shadow redressing cases.
- Invalidate ambiguous native streams on every command timeout/session loss; cancel queued and active work without overtaking an active request.
- Preserve exact credential usernames, expire caches on reads and session changes, merge in-flight names queries, and invalidate caches after save acknowledgements.
- Keep generated passwords out of current-password fields; scope save snapshots, check confirmation values, hand off before asynchronous hashing, and expose expiring save/retry/cancel states.
- Separate list refresh from explicit refill, retain iframe targets, improve errors/PIN lifecycle, keyboard focus, viewport layout and theme contrast.
- Read the current browser's actual managed Boolean policy and generate profiles scoped to that browser.
- Run production background code with native transport simulation, add behavior regressions, native tests, artifact/browser CI and a manual acceptance matrix.

## 0.47.0 — 2026-09-04

- Reject native-protocol waiters on disconnect and permit clean reconnect after failed negotiation.
- Pin password delivery to an exact frame and origin; refuse hidden/offscreen and non-HTTPS targets.
- Move PIN entry out of page DOM and protect account suggestions with a closed Shadow DOM.
- Require recent user intent before save/update requests; expire plaintext and login-name caches explicitly.
- Remove the page-world passkey monkey patch and the redundant MV3 keep-alive alarm.
- Reduce permissions, add a keyboard shortcut, Chinese/English localization, Helium policy-helper support,
  independent security/crypto tests, CI, and reproducible checksummed builds.
- Bound stalled Touch ID reads, discard stale fill responses, and clean per-tab/MRU state in long sessions.
- Make concurrent startup connections await one negotiation and give locked-field clicks a
  challenge fallback with visible errors instead of silently losing an unlock attempt.
- Split field policy, iframe allowlist, password generation, and shared utilities into focused modules.
