const assert = require('node:assert/strict');
const test = require('node:test');

function loadStatManagerWithQuery(queryFn) {
    const dbPath = require.resolve('../utils/db');
    const statPath = require.resolve('../utils/statmanager');
    const originalDb = require.cache[dbPath];

    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: { query: queryFn }
    };
    delete require.cache[statPath];

    try {
        return require('../utils/statmanager');
    } finally {
        delete require.cache[statPath];
        if (originalDb) {
            require.cache[dbPath] = originalDb;
        } else {
            delete require.cache[dbPath];
        }
    }
}

test('getStatsByDate aggregates sent Redis queue jobs by sent hour and selected bot', async () => {
    const calls = [];
    const stats = loadStatManagerWithQuery(async (sql, params = []) => {
        calls.push({ sql, params });
        return {
            rows: [
                { hour: 7, bot_name: 'admin_bot', count: '2' },
                { hour: 8, bot_name: 'Huawei', count: 1 }
            ]
        };
    });

    const result = await stats.getStatsByDate('2026-05-07', 'tenant-1');

    assert.deepEqual(result, {
        '07': { admin_bot: 2 },
        '08': { Huawei: 1 }
    });
    assert.match(calls[0].sql, /FROM message_jobs/i);
    assert.match(calls[0].sql, /status = 'sent'/i);
    assert.match(calls[0].sql, /sent_at >= \$1::date/i);
    assert.match(calls[0].sql, /tenant_id = \$2/i);
    assert.deepEqual(calls[0].params, ['2026-05-07', 'tenant-1']);
});
