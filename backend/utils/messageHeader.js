const HEADER_TIMEZONE = process.env.MESSAGE_HEADER_TIMEZONE || 'Asia/Jakarta';

function pad(value, width = 2) {
    return String(value).padStart(width, '0');
}

/**
 * WhatsApp flags an account that pushes the same body over and over. Stamping
 * each outbound message with a millisecond-precision timestamp makes every send
 * a distinct string, which is what keeps repeated broadcasts (and the 39-minute
 * keepalive) from tripping spam detection.
 *
 * Shape: YYYYMMDDHHMMSSmmm — 17 digits, no separators.
 */
function formatHeaderStamp(date = new Date(), timeZone = HEADER_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});

    return [
        parts.year,
        parts.month,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        pad(date.getMilliseconds(), 3)
    ].join('');
}

function buildMessageHeader({ tenantName, date = new Date(), timeZone = HEADER_TIMEZONE }) {
    if (!tenantName) return null;
    return `${String(tenantName).toUpperCase()} - ${formatHeaderStamp(date, timeZone)}`;
}

function applyHeaderToText(text, header) {
    if (!header) return text;
    const body = text ? String(text) : '';
    return body ? `${header}\n\n${body}` : header;
}

/**
 * Text messages get the header prepended to the body. Media gets it prepended to
 * the caption — and a caption-less media message grows one, so it is stamped too.
 */
function applyHeaderToMessage(message, header) {
    if (!header || !message) return message;

    if ('text' in message) {
        return { ...message, text: applyHeaderToText(message.text, header) };
    }

    return { ...message, caption: applyHeaderToText(message.caption, header) };
}

module.exports = {
    formatHeaderStamp,
    buildMessageHeader,
    applyHeaderToText,
    applyHeaderToMessage,
    HEADER_TIMEZONE
};
