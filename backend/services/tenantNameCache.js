const { query } = require('../utils/db');

const DEFAULT_TTL_MS = 300000;

/**
 * Every outbound message needs the tenant's name for its header, and the
 * delivery worker only carries a tenant_id. Hitting the DB per message would put
 * a query on the hot send path, so names are cached — they change rarely.
 */
function createTenantNameCache({ queryFn = query, ttlMs = DEFAULT_TTL_MS } = {}) {
    const cache = new Map();

    async function getTenantName(tenantId, now = Date.now()) {
        if (!tenantId) return null;

        const cached = cache.get(tenantId);
        if (cached && now < cached.expiresAt) {
            return cached.name;
        }

        try {
            const result = await queryFn('SELECT name FROM tenants WHERE id = $1', [tenantId]);
            const name = result.rows[0]?.name || null;
            cache.set(tenantId, { name, expiresAt: now + ttlMs });
            return name;
        } catch (err) {
            // A stale name beats dropping the header (and the send) over a blip.
            return cached ? cached.name : null;
        }
    }

    function invalidate(tenantId) {
        if (tenantId) cache.delete(tenantId);
        else cache.clear();
    }

    return { getTenantName, invalidate };
}

const defaultCache = createTenantNameCache();

module.exports = {
    createTenantNameCache,
    getTenantName: (...args) => defaultCache.getTenantName(...args),
    invalidateTenantName: (...args) => defaultCache.invalidate(...args)
};
