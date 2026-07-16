const net = require('net');

/**
 * Validates a tenant-supplied relay destination.
 *
 * This URL is POSTed to by the server, so an unvalidated value is an SSRF
 * primitive — and in the production pod every service shares a netns on
 * 127.0.0.1, which would put ZYRON's own API within reach.
 *
 * Rule: reject every IP address literal — IPv4 or IPv6, private or public —
 * and require a real hostname. IP literals can be spelled in a large number
 * of alternate encodings that a private-range denylist has to enumerate one
 * by one and will always be missing one of: IPv4-mapped IPv6
 * (::ffff:127.0.0.1), the NAT64 prefix (64:ff9b::7f00:1 embeds
 * 127.0.0.1), integer/hex/octal IPv4 (2130706433, 0x7f000001,
 * 017700000001), and abbreviated IPv6 ranges (fe80::/10 covers far more
 * than a literal 'fe80' string-prefix check catches). A real webhook
 * destination is always a DNS hostname (e.g. api.petag.id), so refusing
 * every IP literal outright — instead of trying to classify which ones are
 * "private" — collapses this whole bypass class into a single check.
 *
 * This is save-time validation only: it does not resolve the hostname, so
 * DNS rebinding (a hostname that later resolves to a private/loopback
 * address) is explicitly out of scope here.
 */
function validateRelayUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { ok: false, error: 'destination_url must be a valid URL' };
    }

    if (parsed.protocol !== 'https:') {
        return { ok: false, error: 'destination_url must use https' };
    }

    // URL.hostname keeps IPv6 literals wrapped in brackets (e.g.
    // "[::1]"); net.isIP needs them stripped to recognize the address.
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

    if (net.isIP(host)) {
        return { ok: false, error: 'destination_url must be a hostname, not an IP address' };
    }

    const bareHost = host.endsWith('.') ? host.slice(0, -1) : host;
    if (bareHost === 'localhost' || bareHost.endsWith('.localhost')) {
        return { ok: false, error: 'destination_url must not point at localhost' };
    }

    return { ok: true, url: parsed.toString() };
}

module.exports = { validateRelayUrl };
