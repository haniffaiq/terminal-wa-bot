const assert = require('node:assert/strict');
const test = require('node:test');

const { createSendThrottle, msUntilLocalMidnight } = require('../services/sendThrottle');

const BOT = { tenantId: 'tenant-1', botId: 'bot-a' };

test('first send is allowed and consumes one of the daily allowance', () => {
    const t = createSendThrottle({ dailyCap: 250, minGapMs: 8000, maxGapMs: 30000, random: () => 0 });

    assert.deepEqual(t.check({ ...BOT, now: 0 }), { allowed: true });
    t.commit({ ...BOT, now: 0 });
    assert.equal(t.snapshot({ ...BOT, now: 0 }).count, 1);
});

test('a send inside the randomised gap is paced, not sent', () => {
    // random() = 0 -> gap is exactly minGapMs = 8000.
    const t = createSendThrottle({ minGapMs: 8000, maxGapMs: 30000, random: () => 0 });

    t.commit({ ...BOT, now: 1000 });

    const blocked = t.check({ ...BOT, now: 5000 });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'pacing');
    assert.equal(blocked.retryMs, 4000); // armed until 9000, now 5000

    assert.deepEqual(t.check({ ...BOT, now: 9000 }), { allowed: true });
});

test('the gap is randomised between min and max, never fixed', () => {
    const gaps = new Set();
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const t = createSendThrottle({ minGapMs: 8000, maxGapMs: 30000, random: () => r });
        const { nextAllowedAt } = t.commit({ ...BOT, now: 0 });
        gaps.add(nextAllowedAt);
    }

    assert.equal(gaps.size, 5);
    for (const gap of gaps) {
        assert.ok(gap >= 8000 && gap <= 30000, `gap ${gap} out of range`);
    }
});

test('the daily cap stops the bot until local midnight', () => {
    const t = createSendThrottle({ dailyCap: 3, minGapMs: 0, maxGapMs: 0, random: () => 0 });

    let now = 0;
    for (let i = 0; i < 3; i += 1) {
        assert.equal(t.check({ ...BOT, now }).allowed, true);
        t.commit({ ...BOT, now });
        now += 1000;
    }

    const capped = t.check({ ...BOT, now });
    assert.equal(capped.allowed, false);
    assert.equal(capped.reason, 'daily_cap');
    assert.ok(capped.retryMs > 0);
});

test('the daily count resets on the next local day', () => {
    const t = createSendThrottle({ dailyCap: 1, minGapMs: 0, maxGapMs: 0, timeZone: 'Asia/Jakarta', random: () => 0 });

    // 2026-07-12T02:00:00Z == 09:00 Jakarta.
    const day1 = Date.parse('2026-07-12T02:00:00Z');
    t.commit({ ...BOT, now: day1 });
    assert.equal(t.check({ ...BOT, now: day1 }).allowed, false);

    // 2026-07-13T02:00:00Z == 09:00 Jakarta next day.
    const day2 = Date.parse('2026-07-13T02:00:00Z');
    assert.equal(t.check({ ...BOT, now: day2 }).allowed, true);
});

test('caps are per bot, not shared across a tenant', () => {
    const t = createSendThrottle({ dailyCap: 1, minGapMs: 0, maxGapMs: 0, random: () => 0 });

    t.commit({ tenantId: 'tenant-1', botId: 'bot-a', now: 0 });

    assert.equal(t.check({ tenantId: 'tenant-1', botId: 'bot-a', now: 0 }).allowed, false);
    assert.equal(t.check({ tenantId: 'tenant-1', botId: 'bot-b', now: 0 }).allowed, true);
});

test('a zero cap disables throttling entirely', () => {
    const t = createSendThrottle({ dailyCap: 0 });

    for (let i = 0; i < 1000; i += 1) {
        assert.equal(t.check({ ...BOT, now: i }).allowed, true);
    }
});

test('msUntilLocalMidnight is positive and within a day', () => {
    const ms = msUntilLocalMidnight(Date.parse('2026-07-12T02:00:00Z'), 'Asia/Jakarta');
    // 09:00 Jakarta -> 15h left.
    assert.ok(ms > 0 && ms <= 86400000);
    assert.equal(Math.round(ms / 3600000), 15);
});
