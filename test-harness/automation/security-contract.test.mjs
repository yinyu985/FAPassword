// Security behavior lives in drive-security.mjs (real worker) and protocol/cache tests.
// These are actual URL/encoding boundaries rather than searches for code strings.
import assert from 'node:assert/strict';
import { isLocalDevHost, pageContext, normalizePin, errorKey } from '../../src/shared.js';
for (const host of ['localhost','127.0.0.1','[::1]','app.localhost']) assert.equal(isLocalDevHost(host), true);
for (const host of ['app.test','localhost.evil.com','192.168.1.2','127.0.0.1.evil.com']) assert.equal(isLocalDevHost(host), false);
assert.equal(pageContext('https://EXAMPLE.com:443/path').origin, 'https://example.com');
assert.notEqual(pageContext('https://example.com:8443').origin, pageContext('https://example.com').origin);
assert.equal(normalizePin('１２３ ４５６'), '123456');
assert.equal(errorKey(new Error('invalid session')), 'errorLocked');
console.log('PASS loopback exceptions, exact origins, PIN normalization and localized error classification');
