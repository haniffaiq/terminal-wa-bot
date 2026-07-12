const assert = require('node:assert/strict');
const test = require('node:test');

const { createKeepAliveService } = require('../services/keepAliveService');

const SILENT = { log() {}, warn() {}, error() {} };
const NOW = new Date('2026-07-12T05:00:00.000Z');

function makeSock() {
    const sent = [];
    const presence = [];
    return {
        sent,
        presence,
        sendMessage: async (target, content) => sent.push({ target, content }),
        sendPresenceUpdate: async (state) => presence.push(state)
    };
}

function registryWith({ bots = {}, groupSender = null } = {}) {
    return {
        getActiveBotIdsForTenant: () => Object.keys(bots),
        getBotSocket: (tenantId, botId) => bots[botId] || null,
        getNextBotForGroup: () => groupSender
    };
}

test('pushes a presence update on every connected bot and posts one group message', async () => {
    const botA = makeSock();
    const botB = makeSock();
    const updates = [];

    const service = createKeepAliveService({
        queryFn: async (sql, params) => {
            if (sql.includes('UPDATE bot_keepalive')) {
                updates.push(params);
                return { rows: [] };
            }
            return {
                rows: [{
                    id: 'ka-1',
                    tenant_id: 'tenant-1',
                    group_id: '1203@g.us',
                    interval_minutes: 39,
                    tenant_name: 'petagid'
                }]
            };
        },
        botRegistry: registryWith({ bots: { 'bot-a': botA, 'bot-b': botB }, groupSender: botA }),
        logger: SILENT
    });

    const results = await service.tick(NOW);

    // Presence on both sockets is what actually keeps each session warm.
    assert.deepEqual(botA.presence, ['available']);
    assert.deepEqual(botB.presence, ['available']);

    assert.equal(botA.sent.length, 1);
    assert.equal(botB.sent.length, 0);
    assert.equal(botA.sent[0].target, '1203@g.us');
    // Repeating the identical body every 39 minutes is exactly what gets an
    // account flagged, so the keepalive carries the same stamped header.
    // NOW is 05:00Z == 12:00 Jakarta.
    assert.match(botA.sent[0].content.text, /^PETAGID - 20260712120000000\n\n/);
    assert.match(botA.sent[0].content.text, /Bot masih connect/);
    assert.match(botA.sent[0].content.text, /bot-a/);
    assert.match(botA.sent[0].content.text, /bot-b/);

    assert.deepEqual(results, [{ groupId: '1203@g.us', sent: true, pinged: 2 }]);
    assert.deepEqual(updates, [['ka-1']]);
});

test('only picks up rows whose interval has elapsed', async () => {
    let sql = '';
    const service = createKeepAliveService({
        queryFn: async (statement) => {
            sql = statement.replace(/\s+/g, ' ');
            return { rows: [] };
        },
        botRegistry: registryWith(),
        logger: SILENT
    });

    await service.tick(NOW);

    assert.match(sql, /k\.is_active = TRUE/i);
    assert.match(sql, /t\.is_active = TRUE/i);
    assert.match(sql, /k\.last_run_at IS NULL/i);
    assert.match(sql, /k\.interval_minutes \* INTERVAL '1 minute'/i);
});

test('does nothing when the tenant has no connected bot', async () => {
    const updates = [];
    const service = createKeepAliveService({
        queryFn: async (sql, params) => {
            if (sql.includes('UPDATE bot_keepalive')) {
                updates.push(params);
                return { rows: [] };
            }
            return { rows: [{ id: 'ka-1', tenant_id: 'tenant-1', group_id: '1203@g.us', interval_minutes: 39, tenant_name: 'petagid' }] };
        },
        botRegistry: registryWith({ bots: {} }),
        logger: SILENT
    });

    const results = await service.tick(NOW);

    assert.deepEqual(results, [{ groupId: '1203@g.us', sent: false, pinged: 0 }]);
    // last_run_at must not advance, so the next tick retries once a bot is back.
    assert.deepEqual(updates, []);
});

test('still marks the run when no bot is a member of the target group', async () => {
    const botA = makeSock();
    const updates = [];
    const service = createKeepAliveService({
        queryFn: async (sql, params) => {
            if (sql.includes('UPDATE bot_keepalive')) {
                updates.push(params);
                return { rows: [] };
            }
            return { rows: [{ id: 'ka-1', tenant_id: 'tenant-1', group_id: '1203@g.us', interval_minutes: 39, tenant_name: 'petagid' }] };
        },
        botRegistry: registryWith({ bots: { 'bot-a': botA }, groupSender: null }),
        logger: SILENT
    });

    const results = await service.tick(NOW);

    // Presence still fired — that is the part that keeps the session alive.
    assert.deepEqual(botA.presence, ['available']);
    assert.deepEqual(results, [{ groupId: '1203@g.us', sent: false, pinged: 1 }]);
    assert.deepEqual(updates, [['ka-1']]);
});

test('a send failure does not abort the tick', async () => {
    const botA = makeSock();
    botA.sendMessage = async () => { throw new Error('rate limited'); };

    const service = createKeepAliveService({
        queryFn: async (sql) => {
            if (sql.includes('UPDATE bot_keepalive')) return { rows: [] };
            return { rows: [{ id: 'ka-1', tenant_id: 'tenant-1', group_id: '1203@g.us', interval_minutes: 39, tenant_name: 'petagid' }] };
        },
        botRegistry: registryWith({ bots: { 'bot-a': botA }, groupSender: botA }),
        logger: SILENT
    });

    const results = await service.tick(NOW);

    assert.deepEqual(results, [{ groupId: '1203@g.us', sent: false, pinged: 1 }]);
});

test('a failing lookup returns empty instead of crashing the interval', async () => {
    const service = createKeepAliveService({
        queryFn: async () => { throw new Error('db down'); },
        botRegistry: registryWith(),
        logger: SILENT
    });

    assert.deepEqual(await service.tick(NOW), []);
});
