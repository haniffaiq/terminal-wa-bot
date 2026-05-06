const assert = require('node:assert/strict');
const test = require('node:test');

const { createBotHealthService, startBotHealthMonitor } = require('../services/botHealthService');

function normalizeSql(sql) {
    return sql.replace(/\s+/g, ' ').trim();
}

test('markReconnect increments reconnect_count from zero when existing value is null', async () => {
    const service = createBotHealthService({
        queryFn: async (sql, params = []) => {
            assert.match(normalizeSql(sql), /reconnect_count\s*=\s*COALESCE\(bot_health\.reconnect_count,\s*0\)\s*\+\s*1/i);
            assert.deepEqual(params, ['tenant-1', 'bot-a', 'socket closed']);
            return { rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a', reconnect_count: 1 }] };
        }
    });

    const row = await service.markReconnect({
        tenantId: 'tenant-1',
        botId: 'bot-a',
        error: 'socket closed'
    });

    assert.equal(row.reconnect_count, 1);
});

test('markFailure increments consecutive_failures from zero when existing value is null', async () => {
    const service = createBotHealthService({
        queryFn: async (sql, params = []) => {
            assert.match(normalizeSql(sql), /consecutive_failures\s*=\s*COALESCE\(bot_health\.consecutive_failures,\s*0\)\s*\+\s*1/i);
            assert.deepEqual(params, ['tenant-1', 'bot-a', 'offline', 'send timeout']);
            return { rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a', consecutive_failures: 1 }] };
        }
    });

    const row = await service.markFailure({
        tenantId: 'tenant-1',
        botId: 'bot-a',
        error: 'send timeout'
    });

    assert.equal(row.consecutive_failures, 1);
});

test('markStaleBotsOffline marks online bots offline after stale interval', async () => {
    const service = createBotHealthService({
        queryFn: async (sql, params = []) => {
            const normalizedSql = normalizeSql(sql);
            assert.match(normalizedSql, /UPDATE bot_health SET status = 'offline'/i);
            assert.match(normalizedSql, /last_error = 'Bot health stale'/i);
            assert.match(normalizedSql, /WHERE status = 'online'/i);
            assert.match(normalizedSql, /last_seen_at IS NOT NULL/i);
            assert.match(normalizedSql, /last_seen_at < NOW\(\) - \(\$1 \* INTERVAL '1 millisecond'\)/i);
            assert.match(normalizedSql, /RETURNING \*/i);
            assert.deepEqual(params, [120000]);
            return { rows: [{ tenant_id: 'tenant-1', bot_id: 'bot-a', status: 'offline' }] };
        }
    });

    const rows = await service.markStaleBotsOffline({ staleAfterMs: 120000 });

    assert.deepEqual(rows, [{ tenant_id: 'tenant-1', bot_id: 'bot-a', status: 'offline' }]);
});

test('startBotHealthMonitor returns stoppable no-op handle when interval is disabled', () => {
    let queryCalls = 0;

    const handle = startBotHealthMonitor({
        queryFn: async () => {
            queryCalls += 1;
            return { rows: [] };
        },
        intervalMs: 0
    });

    assert.equal(typeof handle.stop, 'function');
    handle.stop();
    assert.equal(queryCalls, 0);
});
