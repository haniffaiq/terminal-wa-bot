const assert = require('node:assert/strict');
const test = require('node:test');

const { validateRelayUrl } = require('../utils/relayUrl');

test('accepts a normal https url', () => {
    const result = validateRelayUrl('https://api.petag.id/webhooks/zyron');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://api.petag.id/webhooks/zyron');
});

test('rejects http', () => {
    assert.equal(validateRelayUrl('http://api.petag.id/webhooks/zyron').ok, false);
});

test('rejects a non-url', () => {
    assert.equal(validateRelayUrl('not a url').ok, false);
    assert.equal(validateRelayUrl('').ok, false);
    assert.equal(validateRelayUrl(null).ok, false);
});

test('rejects a non-https scheme that is still a valid url', () => {
    assert.equal(validateRelayUrl('file:///etc/passwd').ok, false);
    assert.equal(validateRelayUrl('ftp://example.com/x').ok, false);
});

test('rejects loopback IPv4 literal', () => {
    assert.equal(validateRelayUrl('https://127.0.0.1/x').ok, false);
});

test('rejects private IPv4 literals', () => {
    assert.equal(validateRelayUrl('https://10.0.0.5/x').ok, false);
    assert.equal(validateRelayUrl('https://192.168.1.1/x').ok, false);
    assert.equal(validateRelayUrl('https://172.16.0.1/x').ok, false);
    assert.equal(validateRelayUrl('https://172.31.255.254/x').ok, false);
});

test('rejects link-local metadata IPv4 literal', () => {
    assert.equal(validateRelayUrl('https://169.254.169.254/latest/meta-data/').ok, false);
});

test('rejects public IPv4 literals too (superseded: IP literals are always rejected)', () => {
    // These sit just outside the old private ranges, and used to be
    // accepted. Under the new "hostname only" rule, every IP literal is
    // rejected regardless of whether the address happens to be private.
    assert.equal(validateRelayUrl('https://172.15.0.1/x').ok, false);
    assert.equal(validateRelayUrl('https://172.32.0.1/x').ok, false);
    assert.equal(validateRelayUrl('https://11.0.0.1/x').ok, false);
});

test('rejects integer-encoded IPv4 loopback', () => {
    // 2130706433 == 127.0.0.1. The URL parser normalizes this to dotted
    // decimal before .hostname is read, so it must still be caught.
    assert.equal(validateRelayUrl('https://2130706433/x').ok, false);
});

test('rejects hex/octal-encoded IPv4 loopback', () => {
    assert.equal(validateRelayUrl('https://0x7f000001/x').ok, false);
    assert.equal(validateRelayUrl('https://017700000001/x').ok, false);
});

test('rejects loopback and private IPv6 literals', () => {
    assert.equal(validateRelayUrl('https://[::1]/x').ok, false);
    assert.equal(validateRelayUrl('https://[fd00::1]/x').ok, false);
    assert.equal(validateRelayUrl('https://[fe80::1]/x').ok, false);
});

test('rejects a public IPv6 literal', () => {
    assert.equal(validateRelayUrl('https://[2001:4860:4860::8888]/x').ok, false);
});

test('rejects IPv4-mapped IPv6 encodings of loopback and metadata addresses', () => {
    // ::ffff:x.y.z.w bypasses regex-only IPv4 checks because it never
    // matches an IPv4 dotted-quad pattern.
    assert.equal(validateRelayUrl('https://[::ffff:169.254.169.254]/x').ok, false);
    assert.equal(validateRelayUrl('https://[::ffff:127.0.0.1]/x').ok, false);
});

test('rejects NAT64-mapped loopback', () => {
    // 64:ff9b::/96 is the well-known NAT64 prefix; 64:ff9b::7f00:1 embeds
    // 127.0.0.1 and is reachable on NAT64-enabled hosts.
    assert.equal(validateRelayUrl('https://[64:ff9b::7f00:1]/x').ok, false);
});

test('rejects link-local IPv6 addresses outside the narrow fe80 prefix check', () => {
    // fe80::/10 covers fe80 through febf; a literal 'fe80' string-prefix
    // check misses addresses like fe94::1.
    assert.equal(validateRelayUrl('https://[fe94::1]/x').ok, false);
});

test('rejects localhost and subdomains of localhost', () => {
    assert.equal(validateRelayUrl('https://localhost/x').ok, false);
    assert.equal(validateRelayUrl('https://foo.localhost/x').ok, false);
});

test('rejects trailing-dot FQDN forms of localhost', () => {
    assert.equal(validateRelayUrl('https://localhost./x').ok, false);
    assert.equal(validateRelayUrl('https://foo.localhost./x').ok, false);
});

test('accepts a normal hostname with a trailing dot', () => {
    const result = validateRelayUrl('https://api.petag.id./x');
    assert.equal(result.ok, true);
});
