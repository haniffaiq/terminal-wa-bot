const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Baileys announces a [os, browser, version] tuple during the linked-device
// handshake. The library default is a recognisable bot signature; presenting a
// common desktop-browser tuple instead makes the companion look ordinary.
// Override with WA_BROWSER="Mac OS,Chrome,120.0.0".
const DEFAULT_BROWSER = ['Mac OS', 'Chrome', '120.0.0'];

function resolveBrowser(env = process.env) {
    const raw = env.WA_BROWSER;
    if (!raw) return [...DEFAULT_BROWSER];

    const parts = String(raw).split(',').map(p => p.trim());
    if (parts.length !== 3 || parts.some(p => p === '')) {
        return [...DEFAULT_BROWSER];
    }
    return parts;
}

/**
 * Build an outbound proxy agent so a bot's WhatsApp traffic exits a residential
 * IP instead of the datacenter host — the single loudest "this is a server, not
 * a person" signal. Supports socks5:// (preferred for residential pools) and
 * http(s):// proxies. Returns null when no proxy is configured (direct connect).
 */
function buildProxyAgent(proxyUrl) {
    if (!proxyUrl) return null;

    const url = String(proxyUrl).trim();
    if (!url) return null;

    if (url.startsWith('socks')) {
        return new SocksProxyAgent(url);
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return new HttpsProxyAgent(url);
    }
    throw new Error(`Unsupported proxy scheme in "${url}" (use socks5://, http://, or https://)`);
}

module.exports = { resolveBrowser, buildProxyAgent, DEFAULT_BROWSER };
