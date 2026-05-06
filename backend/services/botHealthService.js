const { query } = require('../utils/db');

function createBotHealthService({ queryFn = query } = {}) {
    async function upsertBotHealth({
        tenantId,
        botId,
        status = 'unknown',
        lastSeenAt = null,
        lastReconnectAt = null,
        reconnectCount = 0,
        consecutiveFailures = 0,
        cooldownUntil = null,
        lastError = null
    }) {
        const result = await queryFn(
            `INSERT INTO bot_health (
                tenant_id,
                bot_id,
                status,
                last_seen_at,
                last_reconnect_at,
                reconnect_count,
                consecutive_failures,
                cooldown_until,
                last_error,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (tenant_id, bot_id)
            DO UPDATE SET
                status = EXCLUDED.status,
                last_seen_at = EXCLUDED.last_seen_at,
                last_reconnect_at = EXCLUDED.last_reconnect_at,
                reconnect_count = EXCLUDED.reconnect_count,
                consecutive_failures = EXCLUDED.consecutive_failures,
                cooldown_until = EXCLUDED.cooldown_until,
                last_error = EXCLUDED.last_error,
                updated_at = NOW()
            RETURNING *`,
            [
                tenantId,
                botId,
                status,
                lastSeenAt,
                lastReconnectAt,
                reconnectCount,
                consecutiveFailures,
                cooldownUntil,
                lastError
            ]
        );
        return result.rows[0] || null;
    }

    async function markOnline({ tenantId, botId }) {
        const result = await queryFn(
            `INSERT INTO bot_health (
                tenant_id,
                bot_id,
                status,
                last_seen_at,
                consecutive_failures,
                last_error,
                updated_at
            )
            VALUES ($1, $2, 'online', NOW(), 0, NULL, NOW())
            ON CONFLICT (tenant_id, bot_id)
            DO UPDATE SET
                status = 'online',
                last_seen_at = NOW(),
                consecutive_failures = 0,
                last_error = NULL,
                updated_at = NOW()
            RETURNING *`,
            [tenantId, botId]
        );
        return result.rows[0] || null;
    }

    async function markOffline({ tenantId, botId, error = null }) {
        const result = await queryFn(
            `INSERT INTO bot_health (
                tenant_id,
                bot_id,
                status,
                last_error,
                updated_at
            )
            VALUES ($1, $2, 'offline', $3, NOW())
            ON CONFLICT (tenant_id, bot_id)
            DO UPDATE SET
                status = 'offline',
                last_error = EXCLUDED.last_error,
                updated_at = NOW()
            RETURNING *`,
            [tenantId, botId, error]
        );
        return result.rows[0] || null;
    }

    async function markReconnect({ tenantId, botId, error = null }) {
        const result = await queryFn(
            `INSERT INTO bot_health (
                tenant_id,
                bot_id,
                status,
                last_reconnect_at,
                reconnect_count,
                last_error,
                updated_at
            )
            VALUES ($1, $2, 'reconnecting', NOW(), 1, $3, NOW())
            ON CONFLICT (tenant_id, bot_id)
            DO UPDATE SET
                status = 'reconnecting',
                last_reconnect_at = NOW(),
                reconnect_count = bot_health.reconnect_count + 1,
                last_error = EXCLUDED.last_error,
                updated_at = NOW()
            RETURNING *`,
            [tenantId, botId, error]
        );
        return result.rows[0] || null;
    }

    async function markFailure({ tenantId, botId, error = null, status = 'offline' }) {
        const result = await queryFn(
            `INSERT INTO bot_health (
                tenant_id,
                bot_id,
                status,
                consecutive_failures,
                last_error,
                updated_at
            )
            VALUES ($1, $2, $3, 1, $4, NOW())
            ON CONFLICT (tenant_id, bot_id)
            DO UPDATE SET
                status = EXCLUDED.status,
                consecutive_failures = bot_health.consecutive_failures + 1,
                last_error = EXCLUDED.last_error,
                updated_at = NOW()
            RETURNING *`,
            [tenantId, botId, status, error]
        );
        return result.rows[0] || null;
    }

    function markSuccess({ tenantId, botId }) {
        return markOnline({ tenantId, botId });
    }

    async function getBotHealth({ tenantId, botId }) {
        const result = await queryFn(
            'SELECT * FROM bot_health WHERE tenant_id = $1 AND bot_id = $2',
            [tenantId, botId]
        );
        return result.rows[0] || null;
    }

    async function listBotHealth({ tenantId, status = null } = {}) {
        if (status) {
            const result = await queryFn(
                'SELECT * FROM bot_health WHERE tenant_id = $1 AND status = $2 ORDER BY bot_id',
                [tenantId, status]
            );
            return result.rows;
        }

        const result = await queryFn(
            'SELECT * FROM bot_health WHERE tenant_id = $1 ORDER BY bot_id',
            [tenantId]
        );
        return result.rows;
    }

    return {
        upsertBotHealth,
        markOnline,
        markOffline,
        markReconnect,
        markFailure,
        markSuccess,
        getBotHealth,
        listBotHealth
    };
}

module.exports = {
    createBotHealthService
};
