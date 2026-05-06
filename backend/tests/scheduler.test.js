const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadSchedulerWithStubs({ queueService, queryCalls }) {
    const schedulerPath = require.resolve('../utils/scheduler');
    delete require.cache[schedulerPath];

    const originalLoad = Module._load;
    Module._load = function loadStubbed(request, parent, isMain) {
        if (request === 'node-cron') {
            return { validate: () => true, schedule: () => ({ stop() {} }) };
        }
        if (request === './db' && parent && parent.filename.endsWith('/utils/scheduler.js')) {
            return {
                async query(sql, params) {
                    queryCalls.push({ sql, params });
                    return { rows: [] };
                }
            };
        }
        if (request === '../services/queueService' && parent && parent.filename.endsWith('/utils/scheduler.js')) {
            return queueService;
        }
        return originalLoad.apply(this, arguments);
    };

    try {
        return require('../utils/scheduler');
    } finally {
        Module._load = originalLoad;
    }
}

test('sendScheduledMessage records a run after partial enqueue without deactivating once schedule', async () => {
    const queryCalls = [];
    const enqueueCalls = [];
    const scheduler = loadSchedulerWithStubs({
        queryCalls,
        queueService: {
            async enqueueBulkMessageJobs(payload) {
                enqueueCalls.push(payload);
                throw new Error('queue unavailable');
            },
            async enqueueMessageJob(payload) {
                enqueueCalls.push(payload);
                if (payload.targetId === 'group-2@g.us') {
                    throw new Error('queue unavailable');
                }
                return { id: `job-${payload.targetId}` };
            }
        }
    });

    const result = await scheduler.sendScheduledMessage({
        id: 'schedule-1',
        tenant_id: 'tenant-1',
        target_numbers: ['group-1@g.us', 'group-2@g.us'],
        message: 'Hello',
        schedule_type: 'once'
    });

    assert.equal(result.queued, 1);
    assert.equal(result.failed, 1);
    assert.equal(queryCalls.length, 1);
    assert.match(queryCalls[0].sql, /last_run_at = NOW\(\)/);
    assert.doesNotMatch(queryCalls[0].sql, /is_active = FALSE/);
});
