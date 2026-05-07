const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const { ensureOperationsSchema } = require('../services/schemaService');

test('ensureOperationsSchema creates operational tables and indexes in order', async () => {
    const statements = [];
    const queryFn = async (sql) => {
        statements.push(sql);
        return { rows: [] };
    };

    await ensureOperationsSchema({ queryFn });

    const joined = statements.join('\n');
    const expectedNames = [
        'CREATE TABLE IF NOT EXISTS message_jobs',
        'CREATE TABLE IF NOT EXISTS message_job_attempts',
        'CREATE TABLE IF NOT EXISTS bot_health',
        'CREATE TABLE IF NOT EXISTS operational_events',
        'CREATE TABLE IF NOT EXISTS bot_group_routes',
        'CREATE TABLE IF NOT EXISTS webhook_keys',
        'CREATE INDEX IF NOT EXISTS idx_message_jobs_tenant',
        'CREATE INDEX IF NOT EXISTS idx_message_jobs_status_next_attempt',
        'CREATE INDEX IF NOT EXISTS idx_message_jobs_created_at',
        'CREATE INDEX IF NOT EXISTS idx_message_jobs_target',
        'CREATE INDEX IF NOT EXISTS idx_attempts_job',
        'CREATE INDEX IF NOT EXISTS idx_attempts_tenant',
        'CREATE INDEX IF NOT EXISTS idx_bot_health_tenant_status',
        'CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_created',
        'CREATE INDEX IF NOT EXISTS idx_operational_events_type',
        'CREATE INDEX IF NOT EXISTS idx_bot_group_routes_tenant_group',
        'CREATE INDEX IF NOT EXISTS idx_webhook_key',
        'CREATE INDEX IF NOT EXISTS idx_webhook_tenant'
    ];

    for (const name of expectedNames) {
        assert.match(joined, new RegExp(name));
    }

    assert.equal(statements.length, expectedNames.length);
    assert.ok(statements[0].includes('message_jobs'));
    assert.ok(statements[1].includes('message_job_attempts'));
});

test('requiring schemaService has no DB side effects', () => {
    const schemaServicePath = require.resolve('../services/schemaService');
    const dbPath = path.resolve(__dirname, '../utils/db.js');
    const originalLoad = Module._load;
    let queryCalls = 0;

    delete require.cache[schemaServicePath];

    Module._load = function loadWithDbMock(request, parent, isMain) {
        const resolvedRequest = Module._resolveFilename(request, parent, isMain);
        if (resolvedRequest === dbPath) {
            return {
                query() {
                    queryCalls += 1;
                    return { rows: [] };
                }
            };
        }
        return originalLoad.apply(this, arguments);
    };

    try {
        require('../services/schemaService');
    } finally {
        Module._load = originalLoad;
        delete require.cache[schemaServicePath];
    }

    assert.equal(queryCalls, 0);
});
