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

    function isDuplicateJobError(error) {
        const message = String(error && error.message ? error.message : '').toLowerCase();
        return error && (
            error.code === 'JOB_ALREADY_EXISTS' ||
            message.includes('already exists') ||
            message.includes('duplicate') ||
            message.includes('duplicated')
        );
    }

    async function safeAudit(method, payload) {
        if (!auditService || typeof auditService[method] !== 'function') {
            return;
        }

        try {
            await auditService[method](payload);
        } catch (error) {
            console.warn('Queue audit log failed', {
                method,
                error: error && error.message ? error.message : error
            });
        }
    }

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

    async function reconcileExecutableJob(row) {
        try {
            await addExecutableJob(row, row.priority || 5, row.id);
        } catch (error) {
            if (!isDuplicateJobError(error)) {
                throw error;
            }
        }
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

        await safeAudit('logJobQueued', {
            tenantId,
            jobId: row.id,
            metadata: { source, type, targetId }
        });

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
                AND status IN ('queued', 'retrying')
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
            SELECT
                id,
                tenant_id,
                $3,
                $4,
                $5,
                $6,
                $7,
                CASE WHEN $5 IN ('sent', 'failed') THEN NOW() ELSE NULL END
            FROM message_jobs
            WHERE id = $1
                AND tenant_id = $2
            RETURNING *`,
            [jobId, tenantId, attemptNumber, botId, status, error, responseTimeSeconds]
        );
        return result.rows[0] || null;
    }

    async function markJobSent({ jobId, tenantId, botId, responseTimeSeconds, workerId }) {
        const hasWorkerId = workerId !== undefined && workerId !== null;
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
                AND status = 'sending'
                ${hasWorkerId ? 'AND locked_by = $5' : ''}
            RETURNING *`,
            hasWorkerId
                ? [jobId, tenantId, botId, responseTimeSeconds, workerId]
                : [jobId, tenantId, botId, responseTimeSeconds]
        );
        const row = result.rows[0] || null;

        if (row) {
            await safeAudit('logJobSent', {
                tenantId,
                jobId,
                metadata: { botId, responseTimeSeconds }
            });
        }

        return row;
    }

    async function markJobFailed({ jobId, tenantId, status, error, delaySeconds = 0, workerId }) {
        if (!['retrying', 'failed'].includes(status)) {
            throw new Error('Failed job status must be retrying or failed');
        }

        const hasWorkerId = workerId !== undefined && workerId !== null;
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
                AND status = 'sending'
                ${hasWorkerId ? 'AND locked_by = $6' : ''}
            RETURNING *`,
            hasWorkerId
                ? [jobId, tenantId, status, error, delaySeconds, workerId]
                : [jobId, tenantId, status, error, delaySeconds]
        );
        const row = result.rows[0] || null;

        if (row && status === 'failed') {
            await safeAudit('logJobFailed', {
                tenantId,
                jobId,
                error
            });
        }

        return row;
    }

    async function recoverStaleSendingJobs({ staleAfterSeconds = 300 } = {}) {
        const result = await queryFn(
            `UPDATE message_jobs
            SET
                status = 'retrying',
                locked_at = NULL,
                locked_by = NULL,
                next_attempt_at = NOW(),
                updated_at = NOW()
            WHERE status = 'sending'
                AND locked_at IS NOT NULL
                AND locked_at <= NOW() - ($1 * INTERVAL '1 second')
            RETURNING id, priority`,
            [staleAfterSeconds]
        );
        return result.rows;
    }

    async function requeuePendingJobs({ staleAfterSeconds = 300 } = {}) {
        await recoverStaleSendingJobs({ staleAfterSeconds });

        const result = await queryFn(
            `SELECT id, priority
            FROM message_jobs
            WHERE status IN ('queued', 'retrying')
                AND next_attempt_at <= NOW()
            ORDER BY priority ASC, created_at ASC`
        );

        for (const row of result.rows) {
            await reconcileExecutableJob(row);
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
        recoverStaleSendingJobs,
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
    recoverStaleSendingJobs: (...args) => getDefaultQueueService().recoverStaleSendingJobs(...args),
    requeuePendingJobs: (...args) => getDefaultQueueService().requeuePendingJobs(...args)
};
