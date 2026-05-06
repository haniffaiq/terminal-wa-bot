const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const serviceExportContracts = [
    {
        modulePath: '../services/auditService',
        exports: [
            'createAuditService',
            'logEvent',
            'logJobQueued',
            'logJobSent',
            'logJobFailed',
            'logBotHealthChanged'
        ]
    },
    {
        modulePath: '../services/botHealthService',
        exports: [
            'createBotHealthService',
            'upsertBotHealth',
            'markOnline',
            'markOffline',
            'markReconnect',
            'markFailure',
            'markSuccess',
            'getBotHealth',
            'listBotHealth',
            'markStaleBotsOffline',
            'startBotHealthMonitor'
        ]
    },
    {
        modulePath: '../services/routingService',
        exports: [
            'createRoutingService',
            'selectBotForGroup',
            'recordRouteSuccess',
            'recordRouteFailure',
            'clearRoute'
        ]
    },
    {
        modulePath: '../services/queueService',
        exports: [
            'createQueueService',
            'normalizeTargets',
            'enqueueMessageJob',
            'enqueueBulkMessageJobs',
            'getMessageJob',
            'listMessageJobs',
            'markJobSending',
            'recordAttempt',
            'markJobSent',
            'markJobFailed',
            'requeuePendingJobs'
        ]
    },
    {
        modulePath: '../services/schemaService',
        exports: [
            'ensureOperationsSchema'
        ]
    }
];

test('operation service modules export factory and module-level methods', () => {
    for (const contract of serviceExportContracts) {
        const serviceModule = require(contract.modulePath);

        for (const exportName of contract.exports) {
            assert.equal(
                typeof serviceModule[exportName],
                'function',
                `${contract.modulePath} should export ${exportName}`
            );
        }
    }
});

test('requiring queueService does not create default delivery queue', () => {
    const queueServicePath = require.resolve('../services/queueService');
    const redisQueuePath = path.resolve(__dirname, '../services/redisQueue.js');
    const originalLoad = Module._load;
    let createDeliveryQueueCalls = 0;

    delete require.cache[queueServicePath];

    Module._load = function loadWithRedisQueueMock(request, parent, isMain) {
        const resolvedRequest = Module._resolveFilename(request, parent, isMain);
        if (resolvedRequest === redisQueuePath) {
            return {
                createDeliveryQueue() {
                    createDeliveryQueueCalls += 1;
                    return { add: async () => ({}) };
                }
            };
        }
        return originalLoad.apply(this, arguments);
    };

    try {
        require('../services/queueService');
    } finally {
        Module._load = originalLoad;
        delete require.cache[queueServicePath];
    }

    assert.equal(createDeliveryQueueCalls, 0);
});
