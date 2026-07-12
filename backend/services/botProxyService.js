const { query } = require('../utils/db');

const DEFAULT_TTL_MS = 60000;

/**
 * Resolves the outbound proxy URL for a bot from bot_proxies. Cached briefly so
 * a reconnect storm does not hammer the DB, but short enough that a proxy change
 * takes effect on the next reconnect without a restart.
 */
function createBotProxyService({ queryFn = query, ttlMs = DEFAULT_TTL_MS } = {}) {
    const cache = new Map();

    function keyOf(tenantId, botId) {
        return `${tenantId}:${botId}`;
    }

    async function getProxyUrl(tenantId, botId, now = Date.now()) {
        if (!tenantId || !botId) return null;

        const key = keyOf(tenantId, botId);
        const cached = cache.get(key);
        if (cached && now < cached.expiresAt) {
            return cached.url;
        }

        try {
            const result = await queryFn(
                'SELECT proxy_url FROM bot_proxies WHERE tenant_id = $1 AND bot_id = $2 AND is_active = TRUE',
                [tenantId, botId]
            );
            const url = result.rows[0]?.proxy_url || null;
            cache.set(key, { url, expiresAt: now + ttlMs });
            return url;
        } catch (err) {
            // Missing table or a blip: fall back to direct connect rather than
            // blocking the bot from coming up.
            return cached ? cached.url : null;
        }
    }

    function invalidate(tenantId, botId) {
        if (tenantId && botId) cache.delete(keyOf(tenantId, botId));
        else cache.clear();
    }

    return { getProxyUrl, invalidate };
}

const defaultService = createBotProxyService();

module.exports = {
    createBotProxyService,
    getProxyUrl: (...args) => defaultService.getProxyUrl(...args),
    invalidateProxy: (...args) => defaultService.invalidate(...args)
};
