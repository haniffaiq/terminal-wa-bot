const net = require('net');

const PRIVATE_V4 = [
    /^0\./,
    /^10\./,
    /^127\./,
    /^169\.254\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./
];

/**
 * Validates a tenant-supplied relay destination.
 *
 * This URL is POSTed to by the server, so an unvalidated value is an SSRF
 * primitive — and in the production pod every service shares a netns on
 * 127.0.0.1, which would put ZYRON's own API within reach. Save-time validation
 * cannot stop DNS rebinding; requiring TLS and rejecting literal private
 * addresses is the proportionate guard.
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

    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

    if (host === 'localhost' || host.endsWith('.localhost')) {
        return { ok: false, error: 'destination_url must not point at localhost' };
    }

    if (net.isIPv4(host) && PRIVATE_V4.some((range) => range.test(host))) {
        return { ok: false, error: 'destination_url must not point at a private address' };
    }

    if (net.isIPv6(host)) {
        const isPrivateV6 = host === '::1'
            || host.startsWith('fc')
            || host.startsWith('fd')
            || host.startsWith('fe80');
        if (isPrivateV6) {
            return { ok: false, error: 'destination_url must not point at a private address' };
        }
    }

    return { ok: true, url: parsed.toString() };
}

module.exports = { validateRelayUrl };
