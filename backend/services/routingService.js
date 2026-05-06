const { query } = require('../utils/db');

function createRoutingService({ queryFn = query, socketRegistry } = {}) {
    const registry = socketRegistry || {};

    async function getActiveBotIds(tenantId, groupId) {
        if (typeof registry.getActiveGroupBotIds !== 'function') {
            return [];
        }
        return await registry.getActiveGroupBotIds(tenantId, groupId) || [];
    }

    function getSocket(tenantId, botId) {
        if (!botId || typeof registry.getBotSocket !== 'function') {
            return null;
        }
        return registry.getBotSocket(tenantId, botId) || null;
    }

    async function getPersistedRoute(tenantId, groupId) {
        const result = await queryFn(
            'SELECT * FROM bot_group_routes WHERE tenant_id = $1 AND group_id = $2',
            [tenantId, groupId]
        );
        return result.rows[0] || null;
    }

    async function upsertRoute(tenantId, groupId, botId) {
        const result = await queryFn(
            `INSERT INTO bot_group_routes (
                tenant_id,
                group_id,
                bot_id,
                last_used_at,
                failure_count
            )
            VALUES ($1, $2, $3, NOW(), 0)
            ON CONFLICT (tenant_id, group_id)
            DO UPDATE SET
                bot_id = EXCLUDED.bot_id,
                last_used_at = NOW(),
                failure_count = 0
            RETURNING *`,
            [tenantId, groupId, botId]
        );
        return result.rows[0] || null;
    }

    async function selectBotForGroup({ tenantId, groupId }) {
        const persistedRoute = await getPersistedRoute(tenantId, groupId);
        const activeBotIds = await getActiveBotIds(tenantId, groupId);

        if (persistedRoute && activeBotIds.includes(persistedRoute.bot_id)) {
            const sock = getSocket(tenantId, persistedRoute.bot_id);
            if (sock) {
                return { botId: persistedRoute.bot_id, sock };
            }
        }

        for (const botId of activeBotIds) {
            const sock = getSocket(tenantId, botId);
            if (sock) {
                await upsertRoute(tenantId, groupId, botId);
                return { botId, sock };
            }
        }

        return { botId: null, sock: null };
    }

    async function recordRouteSuccess({ tenantId, groupId, botId }) {
        if (botId) {
            return upsertRoute(tenantId, groupId, botId);
        }

        const result = await queryFn(
            `UPDATE bot_group_routes
            SET
                last_used_at = NOW(),
                failure_count = 0
            WHERE tenant_id = $1
                AND group_id = $2
            RETURNING *`,
            [tenantId, groupId]
        );
        return result.rows[0] || null;
    }

    async function recordRouteFailure({ tenantId, groupId }) {
        const result = await queryFn(
            `UPDATE bot_group_routes
            SET
                failure_count = failure_count + 1,
                last_used_at = NOW()
            WHERE tenant_id = $1
                AND group_id = $2
            RETURNING *`,
            [tenantId, groupId]
        );
        return result.rows[0] || null;
    }

    async function clearRoute({ tenantId, groupId }) {
        const result = await queryFn(
            'DELETE FROM bot_group_routes WHERE tenant_id = $1 AND group_id = $2 RETURNING *',
            [tenantId, groupId]
        );
        return result.rows[0] || null;
    }

    return {
        selectBotForGroup,
        recordRouteSuccess,
        recordRouteFailure,
        clearRoute
    };
}

let defaultRoutingService;

function getDefaultRoutingService() {
    if (!defaultRoutingService) {
        defaultRoutingService = createRoutingService();
    }
    return defaultRoutingService;
}

module.exports = {
    createRoutingService,
    selectBotForGroup: (...args) => getDefaultRoutingService().selectBotForGroup(...args),
    recordRouteSuccess: (...args) => getDefaultRoutingService().recordRouteSuccess(...args),
    recordRouteFailure: (...args) => getDefaultRoutingService().recordRouteFailure(...args),
    clearRoute: (...args) => getDefaultRoutingService().clearRoute(...args)
};
