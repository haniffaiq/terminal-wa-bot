const assert = require('node:assert/strict');
const test = require('node:test');

const { createRoutingService } = require('../services/routingService');

function createSocketRegistry({ activeBotIds = [], sockets = {} } = {}) {
    return {
        activeCalls: [],
        socketCalls: [],
        getActiveGroupBotIds(tenantId, groupId) {
            this.activeCalls.push({ tenantId, groupId });
            return activeBotIds;
        },
        getBotSocket(tenantId, botId) {
            this.socketCalls.push({ tenantId, botId });
            return sockets[botId] || null;
        }
    };
}

test('selects existing persisted route when bot is active', async () => {
    const calls = [];
    const sock = { id: 'sock-a' };
    const queryFn = async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT/i.test(sql) && /bot_group_routes/i.test(sql)) {
            return { rows: [{ bot_id: 'bot-a' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
    };
    const socketRegistry = createSocketRegistry({
        activeBotIds: ['bot-a', 'bot-b'],
        sockets: { 'bot-a': sock }
    });

    const service = createRoutingService({ queryFn, socketRegistry });
    const selected = await service.selectBotForGroup({
        tenantId: 'tenant-1',
        groupId: 'group-1'
    });

    assert.deepEqual(selected, { botId: 'bot-a', sock });
    assert.deepEqual(socketRegistry.activeCalls, [{ tenantId: 'tenant-1', groupId: 'group-1' }]);
    assert.equal(calls.some(call => /INSERT/i.test(call.sql)), false);
});

test('falls back to active bot and upserts when persisted bot inactive', async () => {
    const calls = [];
    const sock = { id: 'sock-b' };
    const queryFn = async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT/i.test(sql) && /bot_group_routes/i.test(sql)) {
            return { rows: [{ bot_id: 'bot-a' }] };
        }
        if (/INSERT/i.test(sql) && /bot_group_routes/i.test(sql)) {
            return { rows: [{ tenant_id: params[0], group_id: params[1], bot_id: params[2] }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
    };
    const socketRegistry = createSocketRegistry({
        activeBotIds: ['bot-b'],
        sockets: { 'bot-b': sock }
    });

    const service = createRoutingService({ queryFn, socketRegistry });
    const selected = await service.selectBotForGroup({
        tenantId: 'tenant-1',
        groupId: 'group-1'
    });

    assert.deepEqual(selected, { botId: 'bot-b', sock });
    const upsert = calls.find(call => /INSERT/i.test(call.sql) && /ON CONFLICT/i.test(call.sql));
    assert.ok(upsert);
    assert.deepEqual(upsert.params.slice(0, 3), ['tenant-1', 'group-1', 'bot-b']);
});

test('returns null bot/socket when no active bot exists', async () => {
    const calls = [];
    const queryFn = async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT/i.test(sql) && /bot_group_routes/i.test(sql)) {
            return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
    };
    const socketRegistry = createSocketRegistry({ activeBotIds: [] });

    const service = createRoutingService({ queryFn, socketRegistry });
    const selected = await service.selectBotForGroup({
        tenantId: 'tenant-1',
        groupId: 'group-1'
    });

    assert.deepEqual(selected, { botId: null, sock: null });
    assert.equal(calls.some(call => /INSERT/i.test(call.sql)), false);
});

test('recordRouteFailure increments failure count query', async () => {
    const calls = [];
    const queryFn = async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{ tenant_id: params[0], group_id: params[1], failure_count: 2 }] };
    };

    const service = createRoutingService({ queryFn, socketRegistry: createSocketRegistry() });
    const route = await service.recordRouteFailure({
        tenantId: 'tenant-1',
        groupId: 'group-1'
    });

    assert.equal(route.failure_count, 2);
    assert.match(calls[0].sql, /failure_count\s*=\s*failure_count\s*\+\s*1/i);
    assert.deepEqual(calls[0].params, ['tenant-1', 'group-1']);
});
