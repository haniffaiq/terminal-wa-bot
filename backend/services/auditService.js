const { query } = require('../utils/db');

function createAuditService({ queryFn = query } = {}) {
    async function logEvent({
        tenantId,
        actorType = 'system',
        actorId = null,
        eventType,
        severity = 'info',
        entityType = null,
        entityId = null,
        message,
        metadata = null
    }) {
        const result = await queryFn(
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [
                tenantId,
                actorType,
                actorId,
                eventType,
                severity,
                entityType,
                entityId,
                message,
                metadata
            ]
        );
        return result.rows[0] || null;
    }

    function logJobQueued({ tenantId, jobId, actorType = 'system', actorId = null, metadata = null }) {
        return logEvent({
            tenantId,
            actorType,
            actorId,
            eventType: 'message_job_queued',
            severity: 'info',
            entityType: 'message_job',
            entityId: jobId,
            message: `Message job queued: ${jobId}`,
            metadata
        });
    }

    function logJobSent({ tenantId, jobId, actorType = 'worker', actorId = null, metadata = null }) {
        return logEvent({
            tenantId,
            actorType,
            actorId,
            eventType: 'message_job_sent',
            severity: 'info',
            entityType: 'message_job',
            entityId: jobId,
            message: `Message job sent: ${jobId}`,
            metadata
        });
    }

    function logJobFailed({ tenantId, jobId, actorType = 'worker', actorId = null, error = null, metadata = null }) {
        return logEvent({
            tenantId,
            actorType,
            actorId,
            eventType: 'message_job_failed',
            severity: 'error',
            entityType: 'message_job',
            entityId: jobId,
            message: error ? `Message job failed: ${error}` : `Message job failed: ${jobId}`,
            metadata
        });
    }

    function logBotHealthChanged({
        tenantId,
        botId,
        status,
        actorType = 'system',
        actorId = null,
        severity = 'info',
        metadata = null
    }) {
        return logEvent({
            tenantId,
            actorType,
            actorId,
            eventType: 'bot_health_changed',
            severity,
            entityType: 'bot',
            entityId: botId,
            message: `Bot ${botId} health changed to ${status}`,
            metadata: metadata || { status }
        });
    }

    return {
        logEvent,
        logJobQueued,
        logJobSent,
        logJobFailed,
        logBotHealthChanged
    };
}

let defaultAuditService;

function getDefaultAuditService() {
    if (!defaultAuditService) {
        defaultAuditService = createAuditService();
    }
    return defaultAuditService;
}

module.exports = {
    createAuditService,
    logEvent: (...args) => getDefaultAuditService().logEvent(...args),
    logJobQueued: (...args) => getDefaultAuditService().logJobQueued(...args),
    logJobSent: (...args) => getDefaultAuditService().logJobSent(...args),
    logJobFailed: (...args) => getDefaultAuditService().logJobFailed(...args),
    logBotHealthChanged: (...args) => getDefaultAuditService().logBotHealthChanged(...args)
};
