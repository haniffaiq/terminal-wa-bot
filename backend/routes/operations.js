const express = require('express');
const { query } = require('../utils/db');
const queueService = require('../services/queueService');
const botHealthService = require('../services/botHealthService');
const { reconnectSingleBotAPI } = require('../bots/operationBot');

const router = express.Router();
const RETRYABLE_TERMINAL_STATUSES = ['failed', 'resolved', 'ignored'];

function isSuperAdmin(req) {
    return req.user && req.user.role === 'super_admin';
}

function getTenantScope(req, params, column = 'tenant_id') {
    if (isSuperAdmin(req)) {
        return { clause: '', params };
    }
    params.push(req.user.tenantId);
    return { clause: ` AND ${column} = $${params.length}`, params };
}

function parseLimitOffset(queryParams, defaultLimit = 50, maxLimit = 200) {
    const requestedLimit = Number.parseInt(queryParams.limit, 10);
    const requestedOffset = Number.parseInt(queryParams.offset, 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), maxLimit)
        : defaultLimit;
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
    return { limit, offset };
}

function parseStatusList(status) {
    if (!status) return [];
    return String(status)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function appendStatusFilter(statuses, params) {
    if (statuses.length === 0) return '';
    params.push(statuses);
    return ` AND status = ANY($${params.length}::varchar[])`;
}

function appendTenantFilter(req, params, column = 'tenant_id') {
    const scope = getTenantScope(req, params, column);
    return scope.clause;
}

async function logOperationalEvent({
    tenantId,
    actorType = 'user',
    actorId = null,
    eventType,
    severity = 'info',
    entityType = null,
    entityId = null,
    message,
    metadata = null
}) {
    try {
        await query(
            `INSERT INTO operational_events (
                tenant_id,
                actor_type,
                actor_id,
                event_type,
                severity,
                entity_type,
                entity_id,
                message,
                metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [tenantId, actorType, actorId, eventType, severity, entityType, entityId, message, metadata]
        );
    } catch (error) {
        console.warn('Failed to log operational event:', error.message);
    }
}

async function requeueJobs({ req, jobIds }) {
    const params = [jobIds, RETRYABLE_TERMINAL_STATUSES];
    const tenantClause = appendTenantFilter(req, params);
    const result = await query(
        `UPDATE message_jobs
        SET
            status = 'queued',
            source = 'manual_retry',
            next_attempt_at = NOW(),
            locked_at = NULL,
            locked_by = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = ANY($1::uuid[])
            AND status = ANY($2::varchar[])
            ${tenantClause}
        RETURNING *`,
        params
    );

    if (result.rows.length > 0) {
        await queueService.requeuePendingJobs();
        for (const job of result.rows) {
            await logOperationalEvent({
                tenantId: job.tenant_id,
                actorId: req.user && (req.user.id || req.user.username),
                eventType: 'job_retried',
                entityType: 'message_job',
                entityId: job.id,
                message: `Job ${job.id} queued for retry`,
                metadata: { previous_statuses: RETRYABLE_TERMINAL_STATUSES }
            });
        }
    }

    return result.rows;
}

router.get('/jobs', async (req, res) => {
    try {
        const { limit, offset } = parseLimitOffset(req.query);
        const statuses = parseStatusList(req.query.status);
        const params = [];
        const tenantClause = appendTenantFilter(req, params);
        const statusClause = appendStatusFilter(statuses, params);
        params.push(limit, offset);

        const result = await query(
            `SELECT *
            FROM message_jobs
            WHERE TRUE
                ${tenantClause}
                ${statusClause}
            ORDER BY created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({ success: true, jobs: result.rows, limit, offset });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/bulk-retry', async (req, res) => {
    try {
        const jobIds = req.body.job_ids || req.body.ids;
        if (!Array.isArray(jobIds) || jobIds.length === 0) {
            return res.status(400).json({ success: false, error: 'job_ids must be a non-empty array' });
        }

        const jobs = await requeueJobs({ req, jobIds });
        res.json({
            success: true,
            status: 'queued',
            job_ids: jobs.map(job => job.id),
            queued: jobs.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/jobs/:id', async (req, res) => {
    try {
        const params = [req.params.id];
        const tenantClause = appendTenantFilter(req, params, 'mj.tenant_id');
        const jobResult = await query(
            `SELECT mj.*
            FROM message_jobs mj
            WHERE mj.id = $1
                ${tenantClause}`,
            params
        );

        if (jobResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }

        const attemptsResult = await query(
            `SELECT *
            FROM message_job_attempts
            WHERE job_id = $1
            ORDER BY started_at DESC, attempt_number DESC`,
            [req.params.id]
        );

        res.json({
            success: true,
            job: {
                ...jobResult.rows[0],
                attempts: attemptsResult.rows
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/:id/retry', async (req, res) => {
    try {
        const jobs = await requeueJobs({ req, jobIds: [req.params.id] });
        if (jobs.length === 0) {
            return res.status(404).json({ success: false, error: 'Retryable job not found' });
        }

        res.json({
            success: true,
            status: 'queued',
            job_ids: jobs.map(job => job.id),
            queued: jobs.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/:id/resolve', async (req, res) => {
    try {
        const params = [req.params.id];
        const tenantClause = appendTenantFilter(req, params);
        const result = await query(
            `UPDATE message_jobs
            SET
                status = 'resolved',
                locked_at = NULL,
                locked_by = NULL,
                updated_at = NOW()
            WHERE id = $1
                AND status IN ('failed', 'retrying')
                ${tenantClause}
            RETURNING *`,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Resolvable job not found' });
        }

        await logOperationalEvent({
            tenantId: result.rows[0].tenant_id,
            actorId: req.user && (req.user.id || req.user.username),
            eventType: 'job_resolved',
            entityType: 'message_job',
            entityId: req.params.id,
            message: `Job ${req.params.id} marked resolved`
        });

        res.json({ success: true, job: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/jobs/:id/ignore', async (req, res) => {
    try {
        const params = [req.params.id];
        const tenantClause = appendTenantFilter(req, params);
        const result = await query(
            `UPDATE message_jobs
            SET
                status = 'ignored',
                locked_at = NULL,
                locked_by = NULL,
                updated_at = NOW()
            WHERE id = $1
                AND status IN ('failed', 'retrying', 'queued')
                ${tenantClause}
            RETURNING *`,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Ignorable job not found' });
        }

        await logOperationalEvent({
            tenantId: result.rows[0].tenant_id,
            actorId: req.user && (req.user.id || req.user.username),
            eventType: 'job_ignored',
            entityType: 'message_job',
            entityId: req.params.id,
            message: `Job ${req.params.id} marked ignored`
        });

        res.json({ success: true, job: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/bot-health', async (req, res) => {
    try {
        const statuses = parseStatusList(req.query.status);
        const params = [];
        const tenantClause = appendTenantFilter(req, params);
        const statusClause = appendStatusFilter(statuses, params);
        const result = await query(
            `SELECT *
            FROM bot_health
            WHERE TRUE
                ${tenantClause}
                ${statusClause}
            ORDER BY tenant_id, bot_id`,
            params
        );

        res.json({ success: true, bots: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/bot-health/:botId/reconnect', async (req, res) => {
    try {
        let tenantId = isSuperAdmin(req) ? (req.body.tenant_id || req.query.tenant_id) : req.user.tenantId;
        if (!tenantId && isSuperAdmin(req)) {
            const lookup = await query(
                'SELECT tenant_id FROM bot_health WHERE bot_id = $1 ORDER BY updated_at DESC LIMIT 1',
                [req.params.botId]
            );
            tenantId = lookup.rows[0] && lookup.rows[0].tenant_id;
        }

        if (!tenantId) {
            return res.status(400).json({ success: false, error: 'tenant_id is required for reconnect' });
        }

        await botHealthService.markReconnect({ tenantId, botId: req.params.botId });
        reconnectSingleBotAPI(req.params.botId, tenantId).catch(error => {
            console.error(`[Operations] Reconnect failed for ${req.params.botId}:`, error.message);
        });

        await logOperationalEvent({
            tenantId,
            actorId: req.user && (req.user.id || req.user.username),
            eventType: 'bot_reconnect_requested',
            entityType: 'bot',
            entityId: req.params.botId,
            message: `Reconnect requested for bot ${req.params.botId}`
        });

        res.json({ success: true, status: 'reconnecting', bot_id: req.params.botId, tenant_id: tenantId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/operational-events', async (req, res) => {
    try {
        const { limit, offset } = parseLimitOffset(req.query, 100, 500);
        const params = [];
        const filters = [appendTenantFilter(req, params)];

        if (req.query.event_type) {
            params.push(req.query.event_type);
            filters.push(` AND event_type = $${params.length}`);
        }
        if (req.query.severity) {
            params.push(req.query.severity);
            filters.push(` AND severity = $${params.length}`);
        }
        if (req.query.entity_id) {
            params.push(req.query.entity_id);
            filters.push(` AND entity_id = $${params.length}`);
        }

        params.push(limit, offset);
        const result = await query(
            `SELECT *
            FROM operational_events
            WHERE TRUE
                ${filters.join('')}
            ORDER BY created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({ success: true, events: result.rows, limit, offset });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/ops/summary', async (req, res) => {
    try {
        const jobParams = [];
        const jobTenantClause = appendTenantFilter(req, jobParams);
        const jobStatusResult = await query(
            `SELECT status, COUNT(*)::int AS count
            FROM message_jobs
            WHERE TRUE
                ${jobTenantClause}
            GROUP BY status`,
            jobParams
        );

        const healthParams = [];
        const healthTenantClause = appendTenantFilter(req, healthParams);
        const botHealthResult = await query(
            `SELECT status, COUNT(*)::int AS count
            FROM bot_health
            WHERE TRUE
                ${healthTenantClause}
            GROUP BY status`,
            healthParams
        );

        const eventParams = [];
        const eventTenantClause = appendTenantFilter(req, eventParams);
        const eventResult = await query(
            `SELECT severity, COUNT(*)::int AS count
            FROM operational_events
            WHERE created_at >= NOW() - INTERVAL '24 hours'
                ${eventTenantClause}
            GROUP BY severity`,
            eventParams
        );

        res.json({
            success: true,
            jobs_by_status: jobStatusResult.rows,
            bots_by_status: botHealthResult.rows,
            events_24h_by_severity: eventResult.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
