const THROTTLE_TIMEZONE = process.env.BLAST_TIMEZONE || 'Asia/Jakarta';
const DEFAULT_DAILY_CAP = Number(process.env.BLAST_DAILY_CAP_PER_BOT || 250);
const DEFAULT_MIN_GAP_MS = Number(process.env.BLAST_MIN_GAP_MS || 8000);
const DEFAULT_MAX_GAP_MS = Number(process.env.BLAST_MAX_GAP_MS || 30000);

function jakartaParts(epochMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date(epochMs)).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});
    return parts;
}

function dayKey(epochMs, timeZone) {
    const p = jakartaParts(epochMs, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}

// Milliseconds from now until the next local midnight — a job that hit the daily
// cap is deferred to when the count resets, not retried on a blind fixed loop.
function msUntilLocalMidnight(epochMs, timeZone) {
    const p = jakartaParts(epochMs, timeZone);
    const secondsIntoDay = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
    const msIntoSecond = epochMs % 1000;
    const msLeft = (86400 - secondsIntoDay) * 1000 - msIntoSecond;
    return msLeft > 0 ? msLeft : 1000;
}

/**
 * Paces outbound sends per WhatsApp number so a blast does not read as a bot.
 *
 * Two independent limits per bot:
 *   - a randomised gap between consecutive sends (fixed cadence is the clearest
 *     bot tell there is), and
 *   - a hard daily cap, after which the number goes quiet until local midnight.
 *
 * State is in-memory and per bot key. The delivery worker runs in one process,
 * so a single instance is authoritative; a restart resets the pacing (safe) and
 * the daily count (accepted — a restart is rare next to a 250/day cap).
 */
function createSendThrottle({
    dailyCap = DEFAULT_DAILY_CAP,
    minGapMs = DEFAULT_MIN_GAP_MS,
    maxGapMs = DEFAULT_MAX_GAP_MS,
    timeZone = THROTTLE_TIMEZONE,
    random = Math.random
} = {}) {
    // key -> { nextAllowedAt, day, count }
    const state = new Map();

    function keyOf(tenantId, botId) {
        return `${tenantId}:${botId}`;
    }

    function entryFor(key, now) {
        let entry = state.get(key);
        const today = dayKey(now, timeZone);
        if (!entry) {
            entry = { nextAllowedAt: 0, day: today, count: 0 };
            state.set(key, entry);
        } else if (entry.day !== today) {
            entry.day = today;
            entry.count = 0;
        }
        return entry;
    }

    function randomGap() {
        if (maxGapMs <= minGapMs) return minGapMs;
        return Math.round(minGapMs + random() * (maxGapMs - minGapMs));
    }

    // Non-mutating: says whether a send is allowed right now, and if not, how
    // long to wait. The caller commits only once the send actually happens.
    function check({ tenantId, botId, now = Date.now() }) {
        if (dailyCap <= 0) return { allowed: true };

        const entry = entryFor(keyOf(tenantId, botId), now);

        if (entry.count >= dailyCap) {
            return { allowed: false, reason: 'daily_cap', retryMs: msUntilLocalMidnight(now, timeZone) };
        }
        if (now < entry.nextAllowedAt) {
            return { allowed: false, reason: 'pacing', retryMs: entry.nextAllowedAt - now };
        }
        return { allowed: true };
    }

    // Record a completed send: burn one of the day's allowance and arm the next
    // randomised gap.
    function commit({ tenantId, botId, now = Date.now() }) {
        const entry = entryFor(keyOf(tenantId, botId), now);
        entry.count += 1;
        entry.nextAllowedAt = now + randomGap();
        return { count: entry.count, nextAllowedAt: entry.nextAllowedAt };
    }

    function snapshot({ tenantId, botId, now = Date.now() }) {
        const entry = entryFor(keyOf(tenantId, botId), now);
        return { count: entry.count, dailyCap, nextAllowedAt: entry.nextAllowedAt };
    }

    return { check, commit, snapshot, config: { dailyCap, minGapMs, maxGapMs, timeZone } };
}

let defaultThrottle;
function getDefaultSendThrottle() {
    if (!defaultThrottle) defaultThrottle = createSendThrottle();
    return defaultThrottle;
}

module.exports = {
    createSendThrottle,
    getDefaultSendThrottle,
    msUntilLocalMidnight
};
