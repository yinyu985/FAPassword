# Changelog

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
