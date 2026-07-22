const assert = require('node:assert/strict');
const test = require('node:test');

const { createBotWatchdog } = require('../services/botWatchdog');

const SILENT = { log() {}, warn() {}, error() {} };

function registryWith(sockets = {}, reconnecting = {}) {
    return {
        getBotSocket: (tenantId, botId) => sockets[`${tenantId}:${botId}`] || null,
        isReconnecting: (tenantId, botId) => Boolean(reconnecting[`${tenantId}:${botId}`])
    };
}

// A socket whose presence probe resolves — i.e. a genuinely alive connection.
function aliveSocket() {
    return { sendPresenceUpdate: async () => {} };
}

// A socket whose presence write never settles — a half-open TCP.
function halfOpenSocket() {
    return { sendPresenceUpdate: () => new Promise(() => {}) };
}

test('revives a closed bot that still holds auth creds', async () => {
    const reconnected = [];
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith(),
        reconnectFn: async (botId, tenantId) => reconnected.push(`${tenantId}:${botId}`),
        logger: SILENT
    });

    const result = await watchdog.tick(0);

    assert.deepEqual(reconnected, ['tenant-1:bot-a']);
    assert.deepEqual(result.revived, ['tenant-1:bot-a']);
});

test('only considers bots whose creds row still exists', async () => {
    let sql = '';
    const watchdog = createBotWatchdog({
        queryFn: async (statement) => {
            sql = statement.replace(/\s+/g, ' ');
            return { rows: [] };
        },
        botRegistry: registryWith(),
        reconnectFn: async () => {},
        logger: SILENT
    });

    await watchdog.tick(0);

    assert.match(sql, /EXISTS \( SELECT 1 FROM auth_sessions/i);
    assert.match(sql, /a\.key_name = 'creds'/i);
    assert.match(sql, /a\.tenant_id = bs\.tenant_id::text/i);
    assert.match(sql, /t\.is_active = TRUE/i);
});

test('a present socket that answers the probe is left alone and marked alive', async () => {
    const reconnected = [];
    const marked = [];
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith({ 'tenant-1:bot-a': aliveSocket() }),
        reconnectFn: async (botId, tenantId) => reconnected.push(`${tenantId}:${botId}`),
        markSuccessFn: async ({ tenantId, botId }) => marked.push(`${tenantId}:${botId}`),
        logger: SILENT
    });

    const result = await watchdog.tick(0);

    assert.deepEqual(reconnected, []);
    assert.deepEqual(result.revived, []);
    assert.deepEqual(result.alive, ['tenant-1:bot-a']);
    assert.deepEqual(marked, ['tenant-1:bot-a'], 'a live probe refreshes last_seen');
});

test('a half-open socket (probe never settles) is reconnected', async () => {
    const reconnected = [];
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith({ 'tenant-1:bot-a': halfOpenSocket() }),
        reconnectFn: async (botId, tenantId) => reconnected.push(`${tenantId}:${botId}`),
        probeTimeoutMs: 20,
        logger: SILENT
    });

    const result = await watchdog.tick(0);

    assert.deepEqual(reconnected, ['tenant-1:bot-a'], 'a frozen bot_status=open bot must still be caught');
    assert.deepEqual(result.revived, ['tenant-1:bot-a']);
});

test('a present socket whose probe throws is reconnected', async () => {
    const reconnected = [];
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith({ 'tenant-1:bot-a': { sendPresenceUpdate: async () => { throw new Error('socket closed'); } } }),
        reconnectFn: async (botId, tenantId) => reconnected.push(`${tenantId}:${botId}`),
        probeTimeoutMs: 1000,
        logger: SILENT
    });

    await watchdog.tick(0);
    assert.deepEqual(reconnected, ['tenant-1:bot-a']);
});

test('a bot mid-reconnect is skipped without probing or reconnecting', async () => {
    const reconnected = [];
    let probed = false;
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith(
            { 'tenant-1:bot-a': { sendPresenceUpdate: async () => { probed = true; } } },
            { 'tenant-1:bot-a': true }
        ),
        reconnectFn: async (botId, tenantId) => reconnected.push(`${tenantId}:${botId}`),
        logger: SILENT
    });

    const result = await watchdog.tick(0);

    assert.equal(probed, false, 'a settling socket must not be probed');
    assert.deepEqual(reconnected, []);
    assert.deepEqual(result.skipped, ['tenant-1:bot-a']);
});

test('the revive query no longer excludes bots whose bot_status is open', async () => {
    let sql = '';
    const watchdog = createBotWatchdog({
        queryFn: async (statement) => { sql = statement.replace(/\s+/g, ' '); return { rows: [] }; },
        botRegistry: registryWith(),
        reconnectFn: async () => {},
        logger: SILENT
    });

    await watchdog.tick(0);

    assert.doesNotMatch(sql, /status <> 'open'/i, 'half-open bots freeze at open; excluding them reintroduces the bug');
});

test('a live probe clears backoff so a bot that briefly flapped is not held off', async () => {
    let alive = false;
    const attempts = [];
    const socket = { sendPresenceUpdate: async () => { if (!alive) throw new Error('dead'); } };
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith({ 'tenant-1:bot-a': socket }),
        reconnectFn: async () => attempts.push(true),
        markSuccessFn: async () => {},
        baseBackoffMs: 60000,
        probeTimeoutMs: 1000,
        logger: SILENT
    });

    await watchdog.tick(0);        // probe throws -> reconnect, backoff armed
    assert.equal(attempts.length, 1);

    alive = true;
    await watchdog.tick(100);      // probe now succeeds -> backoff cleared
    assert.equal(attempts.length, 1);

    alive = false;
    await watchdog.tick(200);      // dead again, but backoff was cleared -> retries at once
    assert.equal(attempts.length, 2);
});

test('backs off exponentially instead of hammering a bot that will not come back', async () => {
    const attempts = [];
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith(),
        reconnectFn: async () => attempts.push(true),
        baseBackoffMs: 1000,
        maxBackoffMs: 8000,
        logger: SILENT
    });

    await watchdog.tick(0);
    assert.equal(attempts.length, 1);

    // Still inside the first 2s backoff window.
    const blocked = await watchdog.tick(1500);
    assert.equal(attempts.length, 1);
    assert.deepEqual(blocked.skipped, ['tenant-1:bot-a']);

    // Window elapsed — retry allowed.
    await watchdog.tick(2500);
    assert.equal(attempts.length, 2);

    // Second failure doubles the window to 4s, so 3s later is still blocked.
    await watchdog.tick(5500);
    assert.equal(attempts.length, 2);
});

test('backoff caps at maxBackoffMs', async () => {
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith(),
        reconnectFn: async () => {},
        baseBackoffMs: 1000,
        maxBackoffMs: 2000,
        logger: SILENT
    });

    let now = 0;
    for (let i = 0; i < 6; i += 1) {
        await watchdog.tick(now);
        now += 5000;
    }

    // Without a cap the 6th window would be 32s and the 5000ms steps would stall.
    const result = await watchdog.tick(now);
    assert.deepEqual(result.revived, ['tenant-1:bot-a']);
});

test('noteConnected clears the backoff so a recovered bot retries immediately', async () => {
    const attempts = [];
    const watchdog = createBotWatchdog({
        queryFn: async () => ({ rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a' }] }),
        botRegistry: registryWith(),
        reconnectFn: async () => attempts.push(true),
        baseBackoffMs: 60000,
        logger: SILENT
    });

    await watchdog.tick(0);
    await watchdog.tick(100);
    assert.equal(attempts.length, 1);

    watchdog.noteConnected('tenant-1', 'bot-a');

    await watchdog.tick(200);
    assert.equal(attempts.length, 2);
});

test('a reconnect that throws does not stop the rest of the sweep', async () => {
    const reconnected = [];
    const watchdog = createBotWatchdog({
        queryFn: async () => ({
            rows: [
                { tenant_id: 'tenant-1', bot_id: 'bot-a' },
                { tenant_id: 'tenant-1', bot_id: 'bot-b' }
            ]
        }),
        botRegistry: registryWith(),
        reconnectFn: async (botId) => {
            if (botId === 'bot-a') throw new Error('socket refused');
            reconnected.push(botId);
        },
        logger: SILENT
    });

    const result = await watchdog.tick(0);

    assert.deepEqual(reconnected, ['bot-b']);
    assert.deepEqual(result.revived, ['tenant-1:bot-b']);
});

test('a failing lookup returns empty instead of crashing the interval', async () => {
    const watchdog = createBotWatchdog({
        queryFn: async () => { throw new Error('db down'); },
        botRegistry: registryWith(),
        reconnectFn: async () => {},
        logger: SILENT
    });

    const result = await watchdog.tick(0);

    assert.deepEqual(result, { revived: [], skipped: [], alive: [] });
});
