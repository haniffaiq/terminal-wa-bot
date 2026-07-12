const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveBrowser, buildProxyAgent, DEFAULT_BROWSER } = require('../utils/socketFingerprint');

test('defaults to a realistic desktop browser tuple when WA_BROWSER is unset', () => {
    assert.deepEqual(resolveBrowser({}), DEFAULT_BROWSER);
    assert.equal(DEFAULT_BROWSER.length, 3);
});

test('WA_BROWSER overrides the tuple', () => {
    assert.deepEqual(
        resolveBrowser({ WA_BROWSER: 'Windows, Edge, 121.0' }),
        ['Windows', 'Edge', '121.0']
    );
});

test('a malformed WA_BROWSER falls back to the default rather than breaking the handshake', () => {
    assert.deepEqual(resolveBrowser({ WA_BROWSER: 'only,two' }), DEFAULT_BROWSER);
    assert.deepEqual(resolveBrowser({ WA_BROWSER: 'a,,c' }), DEFAULT_BROWSER);
    assert.deepEqual(resolveBrowser({ WA_BROWSER: '' }), DEFAULT_BROWSER);
});

test('no proxy url means a direct connection (null agent)', () => {
    assert.equal(buildProxyAgent(null), null);
    assert.equal(buildProxyAgent(''), null);
    assert.equal(buildProxyAgent('   '), null);
});

test('builds a socks agent for socks5 urls', () => {
    const agent = buildProxyAgent('socks5://user:pass@1.2.3.4:1080');
    assert.ok(agent);
    assert.equal(agent.constructor.name, 'SocksProxyAgent');
});

test('builds an https agent for http(s) urls', () => {
    const http = buildProxyAgent('http://1.2.3.4:8080');
    const https = buildProxyAgent('https://user:pass@1.2.3.4:8080');
    assert.equal(http.constructor.name, 'HttpsProxyAgent');
    assert.equal(https.constructor.name, 'HttpsProxyAgent');
});

test('an unsupported scheme throws so a misconfigured proxy is visible', () => {
    assert.throws(() => buildProxyAgent('ftp://1.2.3.4'), /Unsupported proxy scheme/);
});
