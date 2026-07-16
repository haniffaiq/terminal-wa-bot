const crypto = require('crypto');

/**
 * The exact bytes sent as the request body.
 *
 * The destination recomputes the HMAC over the raw body it receives, so the
 * string built here must be the string that goes on the wire. Handing an object
 * to an HTTP client that re-serializes it can change key order or spacing, which
 * changes the hash and earns a 403.
 */
function buildRelayBody({ from, text, messageId, timestamp }) {
    return JSON.stringify({ from, text, message_id: messageId, timestamp });
}

function signRelayBody(secret, body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

module.exports = { buildRelayBody, signRelayBody };
