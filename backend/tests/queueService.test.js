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
            const job = jobs.find(row => row.id === params[0] && row.tenant_id === params[1]);
            if (!job) {
                return { rows: [] };
            }
            const row = {
                id: `attempt-${attempts.length + 1}`,
                job_id: job.id,
                tenant_id: job.tenant_id,
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

function normalizeSql(sql) {
    return sql.replace(/\s+/g, ' ').trim();
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

test('markJobSending returns null for jobs that are no longer queued or retrying', async () => {
    const terminalJob = {
        id: 'job-1',
        tenant_id: 'tenant-1',
        status: 'sent',
        attempt_count: 1
    };
    const service = createQueueService({
        queryFn: async (sql) => {
            assert.match(sql, /status\s+IN\s*\(\s*'queued'\s*,\s*'retrying'\s*\)/i);
            return { rows: [] };
        },
        deliveryQueue: createDeliveryQueue()
    });

    const job = await service.markJobSending({
        jobId: terminalJob.id,
        tenantId: terminalJob.tenant_id,
        workerId: 'worker-1'
    });

    assert.equal(job, null);
});

test('markJobSent only resolves sending jobs locked by the provided worker', async () => {
    const service = createQueueService({
        queryFn: async (sql, params = []) => {
            assert.match(sql, /status\s*=\s*'sending'/i);
            assert.match(sql, /locked_by\s*=\s*\$5/i);
            assert.deepEqual(params, ['job-1', 'tenant-1', 'bot-a', 1.25, 'worker-1']);
            return { rows: [] };
        },
        deliveryQueue: createDeliveryQueue()
    });

    const job = await service.markJobSent({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        botId: 'bot-a',
        responseTimeSeconds: 1.25,
        workerId: 'worker-1'
    });

    assert.equal(job, null);
});

test('markJobFailed only updates sending jobs locked by the provided worker', async () => {
    const service = createQueueService({
        queryFn: async (sql, params = []) => {
            assert.match(sql, /status\s*=\s*'sending'/i);
            assert.match(sql, /locked_by\s*=\s*\$6/i);
            assert.deepEqual(params, ['job-1', 'tenant-1', 'retrying', 'send failed', 60, 'worker-1']);
            return { rows: [] };
        },
        deliveryQueue: createDeliveryQueue()
    });

    const job = await service.markJobFailed({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        status: 'retrying',
        error: 'send failed',
        delaySeconds: 60,
        workerId: 'worker-1'
    });

    assert.equal(job, null);
});

test('markJobFailed rejects terminal status regression', async () => {
    const service = createQueueService({
        queryFn: async () => {
            throw new Error('query should not run');
        },
        deliveryQueue: createDeliveryQueue()
    });

    await assert.rejects(
        () => service.markJobFailed({
            jobId: 'job-1',
            tenantId: 'tenant-1',
            status: 'sent',
            error: 'send failed'
        }),
        /retrying or failed/
    );
});

test('recordAttempt inserts attempt row', async () => {
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

test('recordAttempt returns null for tenant mismatch without direct tenant insert', async () => {
    const calls = [];
    const service = createQueueService({
        queryFn: async (sql, params = []) => {
            calls.push({ sql, params });
            assert.match(normalizeSql(sql), /INSERT INTO message_job_attempts .* SELECT id, tenant_id,/i);
            assert.doesNotMatch(normalizeSql(sql), /VALUES\s*\(\s*\$1\s*,\s*\$2/i);
            return { rows: [] };
        },
        deliveryQueue: createDeliveryQueue()
    });

    const attempt = await service.recordAttempt({
        jobId: 'job-1',
        tenantId: 'tenant-2',
        attemptNumber: 1,
        botId: 'bot-a',
        status: 'failed',
        error: 'send failed',
        responseTimeSeconds: 1.25
    });

    assert.equal(attempt, null);
    assert.deepEqual(calls[0].params, [
        'job-1',
        'tenant-2',
        1,
        'bot-a',
        'failed',
        'send failed',
        1.25
    ]);
});

test('enqueueMessageJob ignores audit failures after DB insert and queue add succeed', async () => {
    const store = createMemoryJobQuery();
    const deliveryQueue = createDeliveryQueue();
    const service = createQueueService({
        queryFn: store.queryFn,
        deliveryQueue,
        auditService: {
            async logJobQueued() {
                throw new Error('audit unavailable');
            }
        }
    });

    const job = await service.enqueueMessageJob({
        tenantId: 'tenant-1',
        source: 'api',
        type: 'text',
        targetId: 'group-1',
        payload: { text: 'hello' }
    });

    assert.equal(job.id, 'job-1');
    assert.equal(store.jobs.length, 1);
    assert.equal(deliveryQueue.addCalls.length, 1);
});

test('requeuePendingJobs uses stable job ids and skips duplicate queue adds', async () => {
    const addErrors = new Set(['job-1']);
    const deliveryQueue = {
        addCalls: [],
        async add(name, data, options) {
            this.addCalls.push({ name, data, options });
            if (addErrors.has(options.jobId)) {
                const error = new Error('Job job-1 already exists');
                error.code = 'JOB_ALREADY_EXISTS';
                throw error;
            }
            return { id: options.jobId };
        }
    };
    const service = createQueueService({
        queryFn: async (sql) => {
            if (/UPDATE message_jobs/i.test(sql)) {
                assert.match(sql, /status\s*=\s*'sending'/i);
                return { rows: [] };
            }
            assert.match(sql, /status IN \('queued', 'retrying'\)/i);
            return {
                rows: [
                    { id: 'job-1', priority: 2 },
                    { id: 'job-2', priority: 4 }
                ]
            };
        },
        deliveryQueue
    });

    const rows = await service.requeuePendingJobs();

    assert.deepEqual(rows.map(row => row.id), ['job-1', 'job-2']);
    assert.deepEqual(deliveryQueue.addCalls.map(call => call.options.jobId), ['job-1', 'job-2']);
});

test('requeuePendingJobs recovers stale sending jobs before enqueueing pending work', async () => {
    const calls = [];
    const deliveryQueue = createDeliveryQueue();
    const service = createQueueService({
        queryFn: async (sql, params = []) => {
            calls.push({ sql, params });
            if (/UPDATE message_jobs/i.test(sql)) {
                assert.match(sql, /status\s*=\s*'retrying'/i);
                assert.match(sql, /WHERE status\s*=\s*'sending'/i);
                assert.match(sql, /locked_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL '1 second'\)/i);
                return { rows: [{ id: 'job-stale', priority: 1 }] };
            }
            return { rows: [{ id: 'job-stale', priority: 1 }] };
        },
        deliveryQueue
    });

    await service.requeuePendingJobs({ staleAfterSeconds: 120 });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].params, [120]);
    assert.deepEqual(deliveryQueue.addCalls.map(call => call.options.jobId), ['job-stale']);
});
