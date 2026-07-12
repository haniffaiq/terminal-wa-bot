const TERMINAL_STATUSES = new Set(['sent', 'failed', 'resolved', 'ignored']);
const NO_BOT_ERROR = 'No available bot for target group';

// A throttle deferral must not sit in the queue forever nor block for a full day
// in one hop — clamp so a daily-cap wait re-evaluates itself periodically.
const MIN_DEFER_MS = 1000;
const MAX_DEFER_MS = 6 * 60 * 60 * 1000;

function clampDeferMs(ms) {
    if (!Number.isFinite(ms)) return MIN_DEFER_MS;
    return Math.min(MAX_DEFER_MS, Math.max(MIN_DEFER_MS, Math.round(ms)));
}

function normalizeError(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return error.message || String(error);
}

function getJobId(bullJob) {
    return bullJob && bullJob.data && bullJob.data.jobId;
}

function getTenantId(bullJob) {
    return bullJob && bullJob.data && bullJob.data.tenantId;
}

function validateStringField(value, fieldName) {
    if (value === undefined || value === null) {
        throw new Error(`Delivery job data.${fieldName} is required`);
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Delivery job data.${fieldName} must be a non-empty string`);
    }
    return value;
}

function isRetryNotDue(dbJob, now = new Date()) {
    if (!dbJob || dbJob.status !== 'retrying' || !dbJob.next_attempt_at) {
        return false;
    }

    const nextAttemptAt = new Date(dbJob.next_attempt_at).getTime();
    return Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime();
}

async function maybeCall(service, method, payload) {
    if (service && typeof service[method] === 'function') {
        return service[method](payload);
    }
    return null;
}

async function handleFailure({
    sendingJob,
    botId,
    error,
    queueService,
    routingService,
    botHealthService,
    messageSender,
    deliveryQueue,
    retryService,
    workerId
}) {
    const errorMessage = normalizeError(error);
    const attemptCount = sendingJob.attempt_count || 0;
    const maxAttempts = sendingJob.max_attempts || 1;
    const tenantId = sendingJob.tenant_id;
    const jobId = sendingJob.id;

    await queueService.recordAttempt({
        jobId,
        tenantId,
        attemptNumber: attemptCount,
        botId: botId || null,
        status: 'failed',
        error: errorMessage,
        responseTimeSeconds: null
    });

    if (botId) {
        await maybeCall(routingService, 'recordRouteFailure', {
            tenantId,
            groupId: sendingJob.target_id,
            botId,
            error: errorMessage
        });
        await maybeCall(botHealthService, 'markFailure', {
            tenantId,
            botId,
            error: errorMessage
        });
    }

    const nextState = retryService.getNextJobStateAfterFailure({
        attemptCount,
        maxAttempts,
        error: errorMessage
    });
    const status = nextState.status;
    const delaySeconds = nextState.delaySeconds || 0;

    const markedJob = await queueService.markJobFailed({
        jobId,
        tenantId,
        status,
        error: errorMessage,
        delaySeconds,
        workerId
    });

    if (!markedJob) {
        return { status: 'skipped', reason: 'stale', jobId };
    }

    if (status === 'retrying') {
        await deliveryQueue.add(
            'deliver-message',
            { jobId, tenantId },
            {
                jobId: `retry-${jobId}-${attemptCount}`,
                delay: delaySeconds * 1000,
                priority: sendingJob.priority ?? 5,
                removeOnComplete: true,
                removeOnFail: false
            }
        );
    } else if (status === 'failed' && messageSender && typeof messageSender.cleanupJobPayload === 'function') {
        await messageSender.cleanupJobPayload({ job: sendingJob });
    }

    return { status, jobId, delaySeconds };
}

async function processDeliveryJob(bullJob, deps) {
    const jobId = validateStringField(getJobId(bullJob), 'jobId');
    const tenantId = validateStringField(getTenantId(bullJob), 'tenantId');

    const {
        queueService,
        routingService,
        botHealthService,
        messageSender,
        deliveryQueue,
        workerId = 'worker',
        retryService = require('./retryService'),
        tenantNameResolver = require('./tenantNameCache'),
        sendThrottle = require('./sendThrottle').getDefaultSendThrottle()
    } = deps || {};

    if (!queueService || !routingService || !botHealthService || !messageSender || !deliveryQueue) {
        throw new Error('Delivery worker dependencies are required');
    }

    const dbJob = await queueService.getMessageJob({ jobId, tenantId });

    if (!dbJob) {
        return { status: 'skipped', reason: 'missing', jobId };
    }
    if (TERMINAL_STATUSES.has(dbJob.status)) {
        return { status: 'skipped', reason: 'terminal', jobId };
    }
    if (isRetryNotDue(dbJob)) {
        return { status: 'skipped', reason: 'not_due', jobId };
    }

    // Select the bot before locking so the pacing/daily-cap gate can defer the
    // job without burning a delivery attempt. Selection is a sticky-route lookup
    // with no round-robin side effect, so calling it early is safe.
    const route = await routingService.selectBotForGroup({
        tenantId,
        groupId: dbJob.target_id
    });

    if (route && route.botId) {
        const gate = sendThrottle.check({ tenantId, botId: route.botId });
        if (!gate.allowed) {
            const delay = clampDeferMs(gate.retryMs);
            await deliveryQueue.add(
                'deliver-message',
                { jobId, tenantId },
                {
                    jobId: `throttle-${jobId}-${Date.now()}`,
                    delay,
                    priority: dbJob.priority ?? 5,
                    removeOnComplete: true,
                    removeOnFail: false
                }
            );
            return { status: 'throttled', reason: gate.reason, jobId, botId: route.botId, delayMs: delay };
        }
    }

    const sendingJob = await queueService.markJobSending({
        jobId,
        tenantId,
        workerId
    });

    if (!sendingJob) {
        return { status: 'skipped', reason: 'stale', jobId };
    }

    if (!route || !route.botId || !route.sock) {
        return handleFailure({
            sendingJob,
            botId: null,
            error: NO_BOT_ERROR,
            queueService,
            routingService,
            botHealthService,
            messageSender,
            deliveryQueue,
            retryService,
            workerId
        });
    }

    try {
        const result = await messageSender.sendJob({
            job: sendingJob,
            sock: route.sock,
            tenantName: await tenantNameResolver.getTenantName(sendingJob.tenant_id)
        });
        // Count the send and arm the next randomised gap only after it lands.
        sendThrottle.commit({ tenantId: sendingJob.tenant_id, botId: route.botId });
        const responseTimeSeconds = result.responseTimeSeconds;
        const cleanupError = result.cleanup && result.cleanup.error ? result.cleanup : null;

        await queueService.recordAttempt({
            jobId,
            tenantId: sendingJob.tenant_id,
            attemptNumber: sendingJob.attempt_count,
            botId: route.botId,
            status: 'sent',
            error: null,
            responseTimeSeconds
        });

        const markedJob = await queueService.markJobSent({
            jobId,
            tenantId: sendingJob.tenant_id,
            botId: route.botId,
            responseTimeSeconds,
            workerId
        });

        if (!markedJob) {
            return { status: 'skipped', reason: 'stale', jobId };
        }

        await maybeCall(routingService, 'recordRouteSuccess', {
            tenantId: sendingJob.tenant_id,
            groupId: sendingJob.target_id,
            botId: route.botId
        });
        await maybeCall(botHealthService, 'markSuccess', {
            tenantId: sendingJob.tenant_id,
            botId: route.botId
        });

        if (cleanupError) {
            console.warn('Delivery job media cleanup failed', {
                jobId,
                tenantId: sendingJob.tenant_id,
                filePath: cleanupError.filePath,
                error: cleanupError.error
            });
        }

        return {
            status: 'sent',
            jobId,
            ...(cleanupError ? { cleanupError } : {})
        };
    } catch (error) {
        return handleFailure({
            sendingJob,
            botId: route.botId,
            error,
            queueService,
            routingService,
            botHealthService,
            messageSender,
            deliveryQueue,
            retryService,
            workerId
        });
    }
}

function startDeliveryWorker(deps = {}) {
    const redisQueue = deps.redisQueue || require('./redisQueue');
    const queueService = deps.queueService || require('./queueService');
    const routingService = deps.routingService || require('./routingService');
    const botHealthService = deps.botHealthService || require('./botHealthService');
    const messageSender = deps.messageSender || require('./messageSender');
    const retryService = deps.retryService || require('./retryService');
    const deliveryQueue = deps.deliveryQueue || redisQueue.createDeliveryQueue();
    const workerId = deps.workerId || 'worker';
    const sendThrottle = deps.sendThrottle || require('./sendThrottle').getDefaultSendThrottle();

    return redisQueue.createDeliveryWorker(
        job => processDeliveryJob(job, {
            queueService,
            routingService,
            botHealthService,
            messageSender,
            deliveryQueue,
            retryService,
            workerId,
            sendThrottle
        }),
        deps.workerOptions || {}
    );
}

module.exports = {
    processDeliveryJob,
    startDeliveryWorker
};
