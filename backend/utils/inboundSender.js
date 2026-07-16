const { jidDecode } = require('baileys');

/**
 * The true phone number of a message's sender, or null when only a LID is
 * available.
 *
 * WhatsApp is migrating to LID addressing, where the envelope identifies the
 * sender by an opaque id instead of their number. senderPn carries the real
 * number when WhatsApp provides it — and it does not always provide it.
 *
 * Callers MUST treat null as "do not relay". The destination trusts `from` as
 * proof of phone ownership, so a LID must never be sent in its place.
 */
function resolveSenderPhone(key = {}) {
    const decoded = jidDecode(key.senderPn || key.remoteJid);
    if (!decoded) return null;
    if (decoded.server !== 's.whatsapp.net' && decoded.server !== 'c.us') return null;
    const digits = String(decoded.user || '').replace(/\D/g, '');
    return digits || null;
}

module.exports = { resolveSenderPhone };
