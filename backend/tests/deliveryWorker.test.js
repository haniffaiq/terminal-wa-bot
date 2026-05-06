const assert = require('node:assert/strict');
const test = require('node:test');

const { processDeliveryJob } = require('../services/deliveryWorker');

const baseDbJob = {
    id: 'job-1',
    tenant_id: 'tenant-1',
    type: 'text',
    target_id: 'group-1',
    payload: { text: 'hello' },
    status: 'queued',
    attempt_count: 0,
    max_attempts: 3,
    priority: 4
};

function createDeliveryQueue() {
    return {
        addCalls: [],
        async add(name, data, options) {
            this.addCalls.push({ name, data, options });
            return { id: options.jobId };
        }
    };
}

function createRetryService(nextState) {
    return {
        calls: [],
        getNextJobStateAfterFailure(payload) {
            this.calls.push(payload);
            return nextState;
        }
    };
}

test('processDeliveryJob marks sending, sends, records success, and marks sent', async () => {
    const calls = [];
    const sock = { id: 'sock-a' };
    const sendingJob = { ...baseDbJob, status: 'sending', attempt_count: 1 };
    const queueService = {
        async getMessageJob(payload) {
            calls.push(['getMessageJob', payload]);
            return baseDbJob;
        },
        async markJobSending(payload) {
            calls.push(['markJobSending', payload]);
            return sendingJob;
        },
        async recordAttempt(payload) {
            calls.push(['recordAttempt', payload]);
        },
        async markJobSent(payload) {
            calls.push(['markJobSent', payload]);
            return { ...sendingJob, status: 'sent' };
        }
    };
    const routingService = {
        async selectBotForGroup(payload) {
            calls.push(['selectBotForGroup', payload]);
            return { botId: 'bot-a', sock };
        },
        async recordRouteSuccess(payload) {
            calls.push(['recordRouteSuccess', payload]);
        }
    };
    const botHealthService = {
        async markSuccess(payload) {
            calls.push(['markSuccess', payload]);
        }
    };
    const messageSender = {
        async sendJob(payload) {
            calls.push(['sendJob', payload]);
            return { responseTimeSeconds: 1.25 };
        }
    };

    const result = await processDeliveryJob(
        { data: { jobId: 'job-1' } },
        {
            queueService,
            routingService,
            botHealthService,
            messageSender,
            deliveryQueue: createDeliveryQueue(),
            workerId: 'worker-1'
        }
    );

    assert.deepEqual(result, { status: 'sent', jobId: 'job-1' });
    assert.deepEqual(calls, [
        ['getMessageJob', { jobId: 'job-1' }],
        ['markJobSending', { jobId: 'job-1', tenantId: 'tenant-1', workerId: 'worker-1' }],
        ['selectBotForGroup', { tenantId: 'tenant-1', groupId: 'group-1' }],
        ['sendJob', { job: sendingJob, sock }],
        ['recordAttempt', {
            jobId: 'job-1',
            tenantId: 'tenant-1',
            attemptNumber: 1,
            botId: 'bot-a',
            status: 'sent',
            error: null,
            responseTimeSeconds: 1.25
        }],
        ['markJobSent', {
            jobId: 'job-1',
            tenantId: 'tenant-1',
            botId: 'bot-a',
            responseTimeSeconds: 1.25,
            workerId: 'worker-1'
        }],
        ['recordRouteSuccess', { tenantId: 'tenant-1', groupId: 'group-1', botId: 'bot-a' }],
        ['markSuccess', { tenantId: 'tenant-1', botId: 'bot-a' }]
    ]);
});

test('processDeliveryJob records no-bot failure and schedules delayed retry', async () => {
    const calls = [];
    const deliveryQueue = createDeliveryQueue();
    const retryService = createRetryService({ status: 'retrying', delaySeconds: 60, final: false });
    const sendingJob = { ...baseDbJob, status: 'sending', attempt_count: 2, max_attempts: 4, priority: 2 };
    const queueService = {
        async getMessageJob() {
            return baseDbJob;
        },
        async markJobSending() {
            return sendingJob;
        },
        async recordAttempt(payload) {
            calls.push(['recordAttempt', payload]);
        },
        async markJobFailed(payload) {
            calls.push(['markJobFailed', payload]);
            return { ...sendingJob, status: payload.status };
        }
    };
    const routingService = {
        async selectBotForGroup(payload) {
            calls.push(['selectBotForGroup', payload]);
            return { botId: null, sock: null };
        }
    };
    const botHealthService = {
        async markFailure(payload) {
            calls.push(['markFailure', payload]);
        }
    };
    const messageSender = {
        async sendJob() {
            throw new Error('send should not run');
        }
    };

    const result = await processDeliveryJob(
        { data: { jobId: 'job-1' } },
        {
            queueService,
            routingService,
            botHealthService,
            messageSender,
            deliveryQueue,
            retryService,
            workerId: 'worker-1'
        }
    );

    assert.deepEqual(result, { status: 'retrying', jobId: 'job-1', delaySeconds: 60 });
    assert.deepEqual(calls, [
        ['selectBotForGroup', { tenantId: 'tenant-1', groupId: 'group-1' }],
        ['recordAttempt', {
            jobId: 'job-1',
            tenantId: 'tenant-1',
            attemptNumber: 2,
            botId: null,
            status: 'failed',
            error: 'No available bot for target group',
            responseTimeSeconds: null
        }],
        ['markJobFailed', {
            jobId: 'job-1',
            tenantId: 'tenant-1',
            status: 'retrying',
            error: 'No available bot for target group',
            delaySeconds: 60,
            workerId: 'worker-1'
        }]
    ]);
    assert.deepEqual(retryService.calls, [{
        attemptCount: 2,
        maxAttempts: 4,
        error: 'No available bot for target group'
    }]);
    assert.deepEqual(deliveryQueue.addCalls, [{
        name: 'deliver-message',
        data: { jobId: 'job-1' },
        options: {
            jobId: 'job-1:2',
            delay: 60000,
            priority: 2,
            removeOnComplete: true,
            removeOnFail: false
        }
    }]);
});

test('processDeliveryJob skips missing and terminal DB jobs without sending', async () => {
    const sendCalls = [];
    const terminalStatuses = ['sent', 'failed', 'resolved', 'ignored'];

    const missingResult = await processDeliveryJob(
        { data: { jobId: 'missing-job' } },
        {
            queueService: {
                async getMessageJob() {
                    return null;
                }
            },
            routingService: {},
            botHealthService: {},
            messageSender: {
                async sendJob() {
                    sendCalls.push('missing');
                }
            },
            deliveryQueue: createDeliveryQueue()
        }
    );

    assert.deepEqual(missingResult, { status: 'skipped', reason: 'missing', jobId: 'missing-job' });

    for (const status of terminalStatuses) {
        const result = await processDeliveryJob(
            { data: { jobId: `job-${status}` } },
            {
                queueService: {
                    async getMessageJob() {
                        return { ...baseDbJob, id: `job-${status}`, status };
                    }
                },
                routingService: {},
                botHealthService: {},
                messageSender: {
                    async sendJob() {
                        sendCalls.push(status);
                    }
                },
                deliveryQueue: createDeliveryQueue()
            }
        );

        assert.deepEqual(result, { status: 'skipped', reason: 'terminal', jobId: `job-${status}` });
    }

    assert.deepEqual(sendCalls, []);
});

test('processDeliveryJob send failure with non-retryable policy marks failed without delayed job', async () => {
    const calls = [];
    const sock = { id: 'sock-a' };
    const deliveryQueue = createDeliveryQueue();
    const retryService = createRetryService({ status: 'failed', delaySeconds: 0, final: true });
    const sendError = new Error('invalid group');
    const sendingJob = { ...baseDbJob, status: 'sending', attempt_count: 1 };
    const queueService = {
        async getMessageJob() {
            return baseDbJob;
        },
        async markJobSending() {
            return sendingJob;
        },
        async recordAttempt(payload) {
            calls.push(['recordAttempt', payload]);
        },
        async markJobFailed(payload) {
            calls.push(['markJobFailed', payload]);
            return { ...sendingJob, status: payload.status };
        }
    };
    const routingService = {
        async selectBotForGroup() {
            return { botId: 'bot-a', sock };
        },
        async recordRouteFailure(payload) {
            calls.push(['recordRouteFailure', payload]);
        }
    };
    const botHealthService = {
        async markFailure(payload) {
            calls.push(['markFailure', payload]);
        }
    };
    const messageSender = {
        async sendJob() {
            throw sendError;
        }
    };

    const result = await processDeliveryJob(
        { data: { jobId: 'job-1' } },
        {
            queueService,
            routingService,
            botHealthService,
            messageSender,
            deliveryQueue,
            retryService,
            workerId: 'worker-1'
        }
    );

    assert.deepEqual(result, { status: 'failed', jobId: 'job-1', delaySeconds: 0 });
    assert.deepEqual(calls, [
        ['recordAttempt', {
            jobId: 'job-1',
            tenantId: 'tenant-1',
            attemptNumber: 1,
            botId: 'bot-a',
            status: 'failed',
            error: 'invalid group',
            responseTimeSeconds: null
        }],
        ['recordRouteFailure', { tenantId: 'tenant-1', groupId: 'group-1', botId: 'bot-a', error: 'invalid group' }],
        ['markFailure', { tenantId: 'tenant-1', botId: 'bot-a', error: 'invalid group' }],
        ['markJobFailed', {
            jobId: 'job-1',
            tenantId: 'tenant-1',
            status: 'failed',
            error: 'invalid group',
            delaySeconds: 0,
            workerId: 'worker-1'
        }]
    ]);
    assert.deepEqual(deliveryQueue.addCalls, []);
});
