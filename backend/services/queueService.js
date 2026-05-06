const { query } = require('../utils/db');
const { createDeliveryQueue } = require('./redisQueue');

function normalizeTargets(targets) {
    const normalized = Array.isArray(targets) ? targets : [targets];
    const targetIds = normalized
        .map(target => typeof target === 'string' ? target.trim() : target)
        .filter(target => target);

    if (targetIds.length === 0) {
        throw new Error('At least one target is required');
    }

    return targetIds;
}

function createQueueService({ queryFn = query, deliveryQueue, auditService } = {}) {
    const executableQueue = deliveryQueue || createDeliveryQueue();

    async function addExecutableJob(row, priority, jobId = row.id) {
        return executableQueue.add(
            'deliver-message',
            { jobId: row.id },
            {
                jobId,
                priority,
                removeOnComplete: true,
                removeOnFail: false
            }
        );
    }

    async function enqueueMessageJob({
        tenantId,
        source,
        type,
        targetId,
        payload,
        priority = 5,
        maxAttempts = 3
    }) {
        const result = await queryFn(
            `INSERT INTO message_jobs (
                tenant_id,
                source,
                type,
                target_id,
                payload,
                priority,
                max_attempts,
                status,
                next_attempt_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', NOW())
            RETURNING *`,
            [tenantId, source, type, targetId, payload, priority, maxAttempts]
        );
        const row = result.rows[0];

        await addExecutableJob(row, priority);

        if (auditService && typeof auditService.logJobQueued === 'function') {
            await auditService.logJobQueued({
                tenantId,
                jobId: row.id,
                metadata: { source, type, targetId }
            });
        }

        return row;
    }

    async function enqueueBulkMessageJobs({
        tenantId,
        source,
        type,
        targets,
        payload,
        priority = 5,
        maxAttempts = 3
    }) {
        const targetIds = normalizeTargets(targets);
        if (targetIds.length > 10) {
            throw new Error('Bulk enqueue supports a maximum of 10 targets');
        }

        const jobs = [];
        for (const targetId of targetIds) {
            const job = await enqueueMessageJob({
                tenantId,
                source,
                type,
                targetId,
                payload,
                priority,
                maxAttempts
            });
            jobs.push(job);
        }
        return jobs;
    }

    async function getMessageJob({ jobId, tenantId }) {
        const result = await queryFn(
            'SELECT * FROM message_jobs WHERE id = $1 AND tenant_id = $2',
            [jobId, tenantId]
        );
        return result.rows[0] || null;
    }

    async function listMessageJobs({ tenantId, status, limit = 50, offset = 0 }) {
        if (status) {
            const result = await queryFn(
                `SELECT *
                FROM message_jobs
                WHERE tenant_id = $1
                    AND status = $2
                ORDER BY created_at DESC
                LIMIT $3 OFFSET $4`,
                [tenantId, status, limit, offset]
            );
            return result.rows;
        }

        const result = await queryFn(
            `SELECT *
            FROM message_jobs
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3`,
            [tenantId, limit, offset]
        );
        return result.rows;
    }

    async function markJobSending({ jobId, tenantId, workerId }) {
        const result = await queryFn(
            `UPDATE message_jobs
            SET
                status = 'sending',
                attempt_count = attempt_count + 1,
                locked_at = NOW(),
                locked_by = $3,
                updated_at = NOW()
            WHERE id = $1
                AND tenant_id = $2
            RETURNING *`,
            [jobId, tenantId, workerId]
        );
        return result.rows[0] || null;
    }

    async function recordAttempt({
        jobId,
        tenantId,
        attemptNumber,
        botId,
        status,
        error = null,
        responseTimeSeconds = null
    }) {
        const result = await queryFn(
            `INSERT INTO message_job_attempts (
                job_id,
                tenant_id,
                attempt_number,
                bot_id,
                status,
                error,
                response_time_seconds,
                finished_at
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                CASE WHEN $5 IN ('sent', 'failed') THEN NOW() ELSE NULL END
            )
            RETURNING *`,
            [jobId, tenantId, attemptNumber, botId, status, error, responseTimeSeconds]
        );
        return result.rows[0] || null;
    }

    async function markJobSent({ jobId, tenantId, botId, responseTimeSeconds }) {
        const result = await queryFn(
            `UPDATE message_jobs
            SET
                status = 'sent',
                selected_bot_id = $3,
                response_time_seconds = $4,
                sent_at = NOW(),
                updated_at = NOW(),
                locked_at = NULL,
                locked_by = NULL,
                last_error = NULL
            WHERE id = $1
                AND tenant_id = $2
            RETURNING *`,
            [jobId, tenantId, botId, responseTimeSeconds]
        );
        const row = result.rows[0] || null;

        if (row && auditService && typeof auditService.logJobSent === 'function') {
            await auditService.logJobSent({
                tenantId,
                jobId,
                metadata: { botId, responseTimeSeconds }
            });
        }

        return row;
    }

    async function markJobFailed({ jobId, tenantId, status, error, delaySeconds = 0 }) {
        const result = await queryFn(
            `UPDATE message_jobs
            SET
                status = $3,
                last_error = $4,
                next_attempt_at = NOW() + ($5 * INTERVAL '1 second'),
                locked_at = NULL,
                locked_by = NULL,
                updated_at = NOW()
            WHERE id = $1
                AND tenant_id = $2
            RETURNING *`,
            [jobId, tenantId, status, error, delaySeconds]
        );
        const row = result.rows[0] || null;

        if (row && status === 'failed' && auditService && typeof auditService.logJobFailed === 'function') {
            await auditService.logJobFailed({
                tenantId,
                jobId,
                error
            });
        }

        return row;
    }

    async function requeuePendingJobs() {
        const result = await queryFn(
            `SELECT id, priority
            FROM message_jobs
            WHERE status IN ('queued', 'retrying')
                AND next_attempt_at <= NOW()
            ORDER BY priority ASC, created_at ASC`
        );

        for (const row of result.rows) {
            await addExecutableJob(row, row.priority || 5, `reconcile:${row.id}`);
        }

        return result.rows;
    }

    return {
        normalizeTargets,
        enqueueMessageJob,
        enqueueBulkMessageJobs,
        getMessageJob,
        listMessageJobs,
        markJobSending,
        recordAttempt,
        markJobSent,
        markJobFailed,
        requeuePendingJobs
    };
}

let defaultQueueService;

function getDefaultQueueService() {
    if (!defaultQueueService) {
        defaultQueueService = createQueueService();
    }
    return defaultQueueService;
}

module.exports = {
    createQueueService,
    normalizeTargets,
    enqueueMessageJob: (...args) => getDefaultQueueService().enqueueMessageJob(...args),
    enqueueBulkMessageJobs: (...args) => getDefaultQueueService().enqueueBulkMessageJobs(...args),
    getMessageJob: (...args) => getDefaultQueueService().getMessageJob(...args),
    listMessageJobs: (...args) => getDefaultQueueService().listMessageJobs(...args),
    markJobSending: (...args) => getDefaultQueueService().markJobSending(...args),
    recordAttempt: (...args) => getDefaultQueueService().recordAttempt(...args),
    markJobSent: (...args) => getDefaultQueueService().markJobSent(...args),
    markJobFailed: (...args) => getDefaultQueueService().markJobFailed(...args),
    requeuePendingJobs: (...args) => getDefaultQueueService().requeuePendingJobs(...args)
};
