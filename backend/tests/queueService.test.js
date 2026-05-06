const assert = require('node:assert/strict');
const test = require('node:test');

const { createQueueService } = require('../services/queueService');

function createMemoryJobQuery() {
    const jobs = [];
    const attempts = [];
    const calls = [];
    let jobSeq = 1;

    const queryFn = async (sql, params = []) => {
        calls.push({ sql, params });

        if (/INSERT INTO message_jobs/i.test(sql)) {
            const row = {
                id: `job-${jobSeq++}`,
                tenant_id: params[0],
                source: params[1],
                type: params[2],
                target_id: params[3],
                payload: params[4],
                priority: params[5],
                max_attempts: params[6],
                status: 'queued',
                attempt_count: 0
            };
            jobs.push(row);
            return { rows: [row] };
        }

        if (/UPDATE message_jobs/i.test(sql) && /status\s*=\s*'sending'/i.test(sql)) {
            const job = jobs.find(row => row.id === params[0] && row.tenant_id === params[1]);
            job.status = 'sending';
            job.locked_by = params[2];
            job.attempt_count += 1;
            return { rows: [job] };
        }

        if (/INSERT INTO message_job_attempts/i.test(sql)) {
            const row = {
                id: `attempt-${attempts.length + 1}`,
                job_id: params[0],
                tenant_id: params[1],
                attempt_number: params[2],
                bot_id: params[3],
                status: params[4],
                error: params[5],
                response_time_seconds: params[6]
            };
            attempts.push(row);
            return { rows: [row] };
        }

        if (/DELETE FROM message_jobs/i.test(sql)) {
            throw new Error('message_jobs rows must remain durable');
        }

        throw new Error(`Unexpected query: ${sql}`);
    };

    return { queryFn, jobs, attempts, calls };
}

function createDeliveryQueue({ failAdd = false } = {}) {
    return {
        addCalls: [],
        async add(name, data, options) {
            this.addCalls.push({ name, data, options });
            if (failAdd) {
                throw new Error('BullMQ unavailable');
            }
            return { id: options.jobId };
        }
    };
}

test('normalizes string target and array target', () => {
    const service = createQueueService({
        queryFn: async () => ({ rows: [] }),
        deliveryQueue: createDeliveryQueue()
    });

    assert.deepEqual(service.normalizeTargets('group-1'), ['group-1']);
    assert.deepEqual(service.normalizeTargets(['group-1', 'group-2']), ['group-1', 'group-2']);
});

test('rejects more than 10 bulk targets', async () => {
    const service = createQueueService({
        queryFn: async () => ({ rows: [] }),
        deliveryQueue: createDeliveryQueue()
    });

    await assert.rejects(
        () => service.enqueueBulkMessageJobs({
            tenantId: 'tenant-1',
            source: 'api',
            type: 'text',
            targets: Array.from({ length: 11 }, (_, index) => `group-${index}`),
            payload: { text: 'hello' }
        }),
        /10 targets/
    );
});

test('enqueueMessageJob inserts into DB and calls injected deliveryQueue.add with DB id', async () => {
    const store = createMemoryJobQuery();
    const deliveryQueue = createDeliveryQueue();
    const service = createQueueService({ queryFn: store.queryFn, deliveryQueue });

    const job = await service.enqueueMessageJob({
        tenantId: 'tenant-1',
        source: 'api',
        type: 'text',
        targetId: 'group-1',
        payload: { text: 'hello' },
        priority: 2,
        maxAttempts: 4
    });

    assert.equal(job.id, 'job-1');
    assert.equal(store.jobs.length, 1);
    assert.deepEqual(deliveryQueue.addCalls, [{
        name: 'deliver-message',
        data: { jobId: 'job-1' },
        options: {
            jobId: 'job-1',
            priority: 2,
            removeOnComplete: true,
            removeOnFail: false
        }
    }]);
});

test('BullMQ add failure leaves durable DB row visible by throwing after insert and not issuing delete', async () => {
    const store = createMemoryJobQuery();
    const deliveryQueue = createDeliveryQueue({ failAdd: true });
    const service = createQueueService({ queryFn: store.queryFn, deliveryQueue });

    await assert.rejects(
        () => service.enqueueMessageJob({
            tenantId: 'tenant-1',
            source: 'api',
            type: 'text',
            targetId: 'group-1',
            payload: { text: 'hello' }
        }),
        /BullMQ unavailable/
    );

    assert.equal(store.jobs.length, 1);
    assert.equal(store.calls.some(call => /DELETE FROM message_jobs/i.test(call.sql)), false);
});

test('enqueueBulkMessageJobs creates one DB row and one queue add per target', async () => {
    const store = createMemoryJobQuery();
    const deliveryQueue = createDeliveryQueue();
    const service = createQueueService({ queryFn: store.queryFn, deliveryQueue });

    const jobs = await service.enqueueBulkMessageJobs({
        tenantId: 'tenant-1',
        source: 'api',
        type: 'text',
        targets: ['group-1', 'group-2'],
        payload: { text: 'hello' }
    });

    assert.deepEqual(jobs.map(job => job.id), ['job-1', 'job-2']);
    assert.deepEqual(store.jobs.map(job => job.target_id), ['group-1', 'group-2']);
    assert.deepEqual(deliveryQueue.addCalls.map(call => call.data), [{ jobId: 'job-1' }, { jobId: 'job-2' }]);
});

test('markJobSending increments attempt count and sets sending', async () => {
    const store = createMemoryJobQuery();
    const deliveryQueue = createDeliveryQueue();
    const service = createQueueService({ queryFn: store.queryFn, deliveryQueue });
    await service.enqueueMessageJob({
        tenantId: 'tenant-1',
        source: 'api',
        type: 'text',
        targetId: 'group-1',
        payload: { text: 'hello' }
    });

    const job = await service.markJobSending({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        workerId: 'worker-1'
    });

    assert.equal(job.status, 'sending');
    assert.equal(job.locked_by, 'worker-1');
    assert.equal(job.attempt_count, 1);
    assert.match(store.calls.at(-1).sql, /attempt_count\s*=\s*attempt_count\s*\+\s*1/i);
});

test('recordAttempt inserts attempt row', async () => {
    const store = createMemoryJobQuery();
    const deliveryQueue = createDeliveryQueue();
    const service = createQueueService({ queryFn: store.queryFn, deliveryQueue });

    const attempt = await service.recordAttempt({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        attemptNumber: 1,
        botId: 'bot-a',
        status: 'failed',
        error: 'send failed',
        responseTimeSeconds: 1.25
    });

    assert.equal(attempt.id, 'attempt-1');
    assert.deepEqual(store.attempts, [{
        id: 'attempt-1',
        job_id: 'job-1',
        tenant_id: 'tenant-1',
        attempt_number: 1,
        bot_id: 'bot-a',
        status: 'failed',
        error: 'send failed',
        response_time_seconds: 1.25
    }]);
});
