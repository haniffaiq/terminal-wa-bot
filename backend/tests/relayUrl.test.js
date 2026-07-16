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

test('rejects loopback', () => {
    assert.equal(validateRelayUrl('https://127.0.0.1/x').ok, false);
    assert.equal(validateRelayUrl('https://localhost/x').ok, false);
    assert.equal(validateRelayUrl('https://[::1]/x').ok, false);
});

test('rejects private v4 ranges', () => {
    assert.equal(validateRelayUrl('https://10.0.0.5/x').ok, false);
    assert.equal(validateRelayUrl('https://192.168.1.1/x').ok, false);
    assert.equal(validateRelayUrl('https://172.16.0.1/x').ok, false);
    assert.equal(validateRelayUrl('https://172.31.255.254/x').ok, false);
});

test('rejects link-local metadata addresses', () => {
    assert.equal(validateRelayUrl('https://169.254.169.254/latest/meta-data/').ok, false);
});

test('accepts public addresses just outside the private ranges', () => {
    assert.equal(validateRelayUrl('https://172.15.0.1/x').ok, true);
    assert.equal(validateRelayUrl('https://172.32.0.1/x').ok, true);
    assert.equal(validateRelayUrl('https://11.0.0.1/x').ok, true);
});

test('rejects private v6 ranges', () => {
    assert.equal(validateRelayUrl('https://[fd00::1]/x').ok, false);
    assert.equal(validateRelayUrl('https://[fe80::1]/x').ok, false);
});

test('rejects a non-https scheme that is still a valid url', () => {
    assert.equal(validateRelayUrl('file:///etc/passwd').ok, false);
    assert.equal(validateRelayUrl('ftp://example.com/x').ok, false);
});
