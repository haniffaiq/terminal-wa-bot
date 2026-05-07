const express = require('express');
const { query } = require('../utils/db');
const queueService = require('../services/queueService');
const botHealthService = require('../services/botHealthService');
const { buildUsageCostSummary } = require('../services/usageCostService');
const { reconnectSingleBotAPI } = require('../bots/operationBot');

const router = express.Router();
const RETRYABLE_TERMINAL_STATUSES = ['failed', 'resolved', 'ignored'];
const JOB_SUMMARY_STATUSES = ['queued', 'sending', 'retrying', 'failed', 'resolved', 'ignored'];
const BOT_SUMMARY_STATUSES = ['online', 'offline', 'reconnecting', 'cooldown', 'qr_required', 'unknown'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BOT_STALE_SECONDS = 120;

class BadRequestError extends Error {
    constructor(message) {
        super(message);
        this.statusCode = 400;
    }
}

function sendRouteError(res, error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
}

function isValidUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validateUuidList(values, fieldName) {
    if (!Array.isArray(values) || values.length === 0) {
        return { ok: false, error: `${fieldName} must be a non-empty array` };
    }

    if (!values.every(isValidUuid)) {
        return { ok: false, error: `${fieldName} contains invalid UUID values` };
    }

    return { ok: true };
}

function rejectInvalidUuidParam(req, res, fieldName = 'id') {
    if (isValidUuid(req.params[fieldName])) return false;
    res.status(400).json({ success: false, error: `${fieldName} must be a valid UUID` });
    return true;
}

function isSuperAdmin(req) {
    return req.user && req.user.role === 'super_admin';
}

function getActorId(req) {
    return (req.user && (req.user.userId || req.user.id || req.user.username)) || null;
}

function getTenantScope(req, params, column = 'tenant_id') {
    if (isSuperAdmin(req)) {
        const hasTenantQuery = req.query && Object.prototype.hasOwnProperty.call(req.query, 'tenant_id');
        if (!hasTenantQuery) {
            return { clause: '', params, tenantId: null };
        }
        const requestedTenantId = req.query.tenant_id;
        if (!isValidUuid(requestedTenantId)) {
            throw new BadRequestError('tenant_id must be a valid UUID');
        }
        params.push(requestedTenantId);
        return { clause: ` AND ${column} = $${params.length}`, params, tenantId: requestedTenantId };
    }
    params.push(req.user.tenantId);
    return { clause: ` AND ${column} = $${params.length}`, params, tenantId: req.user.tenantId };
}

function getReconnectTenantId(req) {
    if (!isSuperAdmin(req)) {
        return req.user.tenantId;
    }

    const requestedTenantId = (req.body && (req.body.tenantId || req.body.tenant_id))
        || (req.query && (req.query.tenantId || req.query.tenant_id));
    if (!requestedTenantId) {
        throw new BadRequestError('tenant_id is required for reconnect');
    }
    if (!isValidUuid(requestedTenantId)) {
        throw new BadRequestError('tenant_id must be a valid UUID');
    }
    return requestedTenantId;
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

function appendEqualsFilter(filters, params, column, value) {
    if (!value) return;
    params.push(value);
    filters.push(` AND ${column} = $${params.length}`);
}

function parseDateFilter(value, fieldName) {
    if (!value) return null;
    if (typeof value !== 'string') {
        throw new BadRequestError(`${fieldName} must be a valid date`);
    }

    const trimmed = value.trim();
    const prefixMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
    if (!prefixMatch) {
        throw new BadRequestError(`${fieldName} must be a valid date`);
    }

    const [, yearValue, monthValue, dayValue] = prefixMatch;
    const year = Number.parseInt(yearValue, 10);
    const month = Number.parseInt(monthValue, 10);
    const day = Number.parseInt(dayValue, 10);
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > maxDay || Number.isNaN(Date.parse(trimmed))) {
        throw new BadRequestError(`${fieldName} must be a valid date`);
    }
    return trimmed;
}

function appendDateFilter(filters, params, column, operator, value, fieldName) {
    if (!value) return;
    params.push(parseDateFilter(value, fieldName));
    filters.push(` AND ${column} ${operator} $${params.length}`);
}

function buildJobsQuery(req) {
    const { limit, offset } = parseLimitOffset(req.query);
    const params = [];
    const filters = [
        appendTenantFilter(req, params)
    ];
    const statuses = parseStatusList(req.query.status);
    const statusClause = appendStatusFilter(statuses, params);
    if (statusClause) filters.push(statusClause);

    appendEqualsFilter(filters, params, 'source', req.query.source);
    if (req.query.target) {
        params.push(`%${req.query.target}%`);
        filters.push(` AND target_id ILIKE $${params.length}`);
    }
    appendEqualsFilter(filters, params, 'selected_bot_id', req.query.bot);
    appendDateFilter(filters, params, 'created_at', '>=', req.query.date_from, 'date_from');
    appendDateFilter(filters, params, 'created_at', '<=', req.query.date_to, 'date_to');

    params.push(limit, offset);
    return {
        sql: `SELECT *
            FROM message_jobs
            WHERE TRUE
                ${filters.join('')}
            ORDER BY created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
        limit,
        offset
    };
}

function buildBotHealthQuery(req) {
    const statuses = parseStatusList(req.query.status);
    const params = [];
    const tenantClause = appendTenantFilter(req, params);
    const statusClause = appendStatusFilter(statuses, params);

    return {
        sql: `SELECT *
            FROM bot_health
            WHERE TRUE
                ${tenantClause}
                ${statusClause}
            ORDER BY tenant_id, bot_id`,
        params
    };
}

function buildOperationalEventsQuery(req) {
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
    return {
        sql: `SELECT *
            FROM operational_events
            WHERE TRUE
                ${filters.join('')}
            ORDER BY created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
        limit,
        offset
    };
}

function buildOpsSummaryQueries(req) {
    const jobParams = [];
    const jobTenantClause = appendTenantFilter(req, jobParams);
    const sentTodayParams = [];
    const sentTodayTenantClause = appendTenantFilter(req, sentTodayParams);
    const healthParams = [];
    const healthTenantClause = appendTenantFilter(req, healthParams);
    const staleParams = [getBotStaleSeconds()];
    const staleTenantClause = appendTenantFilter(req, staleParams);

    return {
        jobStatus: {
            sql: `SELECT status, COUNT(*)::int AS count
            FROM message_jobs
            WHERE TRUE
                ${jobTenantClause}
            GROUP BY status`,
            params: jobParams
        },
        sentToday: {
            sql: `SELECT COUNT(*)::int AS count
            FROM message_jobs
            WHERE status = 'sent'
                AND sent_at >= CURRENT_DATE
                AND sent_at < CURRENT_DATE + INTERVAL '1 day'
                ${sentTodayTenantClause}`,
            params: sentTodayParams
        },
        botHealth: {
            sql: `SELECT status, COUNT(*)::int AS count
            FROM bot_health
            WHERE TRUE
                ${healthTenantClause}
            GROUP BY status`,
            params: healthParams
        },
        stale: {
            sql: `SELECT COUNT(*)::int AS count
            FROM bot_health
            WHERE status = 'online'
                AND last_seen_at IS NOT NULL
                AND last_seen_at < NOW() - ($1::int * INTERVAL '1 second')
                ${staleTenantClause}`,
            params: staleParams
        }
    };
}

function buildUsageCostQuery(req) {
    const params = [];
    const tenantClause = appendTenantFilter(req, params);

    return {
        sql: `SELECT
            COUNT(*) FILTER (
                WHERE sent_at >= CURRENT_DATE
                    AND sent_at < CURRENT_DATE + INTERVAL '1 day'
            )::int AS sent_today,
            COUNT(*) FILTER (
                WHERE sent_at >= date_trunc('month', CURRENT_DATE)
                    AND sent_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
            )::int AS sent_month,
            COUNT(*)::int AS sent_total
        FROM message_jobs
        WHERE status = 'sent'
            AND sent_at IS NOT NULL
            ${tenantClause}`,
        params
    };
}

function rowsToCounts(rows, statuses) {
    const counts = Object.fromEntries(statuses.map(status => [status, 0]));
    for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
            counts[row.status] = Number.parseInt(row.count, 10) || 0;
        }
    }
    return counts;
}

function buildOpsSummaryResponse({ jobRows, botRows, staleCount = 0, generatedAt = new Date().toISOString() }) {
    const jobs = rowsToCounts(jobRows, JOB_SUMMARY_STATUSES);
    const sentTodayRow = jobRows.find(row => row.status === 'sent_today');
    jobs.sent_today = sentTodayRow ? Number.parseInt(sentTodayRow.count, 10) || 0 : 0;
    jobs.queue_depth = jobs.queued + jobs.retrying;

    const bots = rowsToCounts(botRows, BOT_SUMMARY_STATUSES);
    bots.total = BOT_SUMMARY_STATUSES.reduce((sum, status) => sum + bots[status], 0);
    bots.stale = Number.parseInt(staleCount, 10) || 0;

    return {
        jobs,
        bots,
        generated_at: generatedAt
    };
}

function getBotStaleSeconds() {
    const configured = Number.parseInt(process.env.BOT_HEALTH_STALE_SECONDS, 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BOT_STALE_SECONDS;
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
                actorId: getActorId(req),
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
        const { sql, params, limit, offset } = buildJobsQuery(req);
        const result = await query(sql, params);

        res.json({ success: true, jobs: result.rows, limit, offset });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.post('/jobs/bulk-retry', async (req, res) => {
    try {
        const jobIds = req.body.job_ids || req.body.ids;
        const validation = validateUuidList(jobIds, 'job_ids');
        if (!validation.ok) {
            return res.status(400).json({ success: false, error: validation.error });
        }

        const jobs = await requeueJobs({ req, jobIds });
        res.json({
            success: true,
            status: 'queued',
            job_ids: jobs.map(job => job.id),
            queued: jobs.length
        });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.get('/jobs/:id', async (req, res) => {
    try {
        if (rejectInvalidUuidParam(req, res)) return;

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
        sendRouteError(res, error);
    }
});

router.post('/jobs/:id/retry', async (req, res) => {
    try {
        if (rejectInvalidUuidParam(req, res)) return;

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
        sendRouteError(res, error);
    }
});

router.post('/jobs/:id/resolve', async (req, res) => {
    try {
        if (rejectInvalidUuidParam(req, res)) return;

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
            actorId: getActorId(req),
            eventType: 'job_resolved',
            entityType: 'message_job',
            entityId: req.params.id,
            message: `Job ${req.params.id} marked resolved`
        });

        res.json({ success: true, job: result.rows[0] });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.post('/jobs/:id/ignore', async (req, res) => {
    try {
        if (rejectInvalidUuidParam(req, res)) return;

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
            actorId: getActorId(req),
            eventType: 'job_ignored',
            entityType: 'message_job',
            entityId: req.params.id,
            message: `Job ${req.params.id} marked ignored`
        });

        res.json({ success: true, job: result.rows[0] });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.get('/bot-health', async (req, res) => {
    try {
        const { sql, params } = buildBotHealthQuery(req);
        const result = await query(sql, params);

        res.json({ success: true, bots: result.rows });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.post('/bot-health/:botId/reconnect', async (req, res) => {
    try {
        const tenantId = getReconnectTenantId(req);

        await botHealthService.markReconnect({ tenantId, botId: req.params.botId });
        reconnectSingleBotAPI(req.params.botId, tenantId).catch(error => {
            console.error(`[Operations] Reconnect failed for ${req.params.botId}:`, error.message);
        });

        await logOperationalEvent({
            tenantId,
            actorId: getActorId(req),
            eventType: 'bot_reconnect_requested',
            entityType: 'bot',
            entityId: req.params.botId,
            message: `Reconnect requested for bot ${req.params.botId}`
        });

        res.json({ success: true, status: 'reconnecting', bot_id: req.params.botId, tenant_id: tenantId });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.get('/operational-events', async (req, res) => {
    try {
        const { sql, params, limit, offset } = buildOperationalEventsQuery(req);
        const result = await query(sql, params);

        res.json({ success: true, events: result.rows, limit, offset });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.get('/ops/summary', async (req, res) => {
    try {
        const queries = buildOpsSummaryQueries(req);
        const jobStatusResult = await query(queries.jobStatus.sql, queries.jobStatus.params);
        const sentTodayResult = await query(queries.sentToday.sql, queries.sentToday.params);
        const botHealthResult = await query(queries.botHealth.sql, queries.botHealth.params);
        const staleResult = await query(queries.stale.sql, queries.stale.params);

        const jobRows = [
            ...jobStatusResult.rows,
            { status: 'sent_today', count: sentTodayResult.rows[0] ? sentTodayResult.rows[0].count : 0 }
        ];

        res.json({
            success: true,
            data: buildOpsSummaryResponse({
                jobRows,
                botRows: botHealthResult.rows,
                staleCount: staleResult.rows[0] ? staleResult.rows[0].count : 0
            })
        });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.get('/usage-costs', async (req, res) => {
    try {
        const usageQuery = buildUsageCostQuery(req);
        const result = await query(usageQuery.sql, usageQuery.params);
        const row = result.rows[0] || {};

        res.json({
            success: true,
            data: buildUsageCostSummary({
                counts: {
                    sent_today: row.sent_today,
                    sent_month: row.sent_month,
                    sent_total: row.sent_total
                }
            })
        });
    } catch (error) {
        sendRouteError(res, error);
    }
});

router.__isValidUuidForTests = isValidUuid;
router.__validateUuidListForTests = validateUuidList;
router.__buildJobsQueryForTests = buildJobsQuery;
router.__buildOpsSummaryResponseForTests = buildOpsSummaryResponse;
router._getActorId = getActorId;
router._getTenantScope = getTenantScope;
router._isUuid = isValidUuid;
router._parseDateFilter = parseDateFilter;
router._buildJobsQuery = buildJobsQuery;
router._buildBotHealthQuery = buildBotHealthQuery;
router._buildOperationalEventsQuery = buildOperationalEventsQuery;
router._buildOpsSummaryQueries = buildOpsSummaryQueries;
router._buildUsageCostQuery = buildUsageCostQuery;
router._getReconnectTenantId = getReconnectTenantId;

module.exports = router;
