const { query } = require('../utils/db');

const DEFAULT_TTL_MS = 60000;

/**
 * Resolves a tenant's inbound relay config. Consulted on every inbound DM, so an
 * uncached read would put a query on the chat path; cached briefly so a config
 * change still takes effect without a restart.
 */
function createInboundRelayConfig({ queryFn = query, ttlMs = DEFAULT_TTL_MS } = {}) {
    const cache = new Map();

    async function getRelay(tenantId, now = Date.now()) {
        if (!tenantId) return null;

        const cached = cache.get(tenantId);
        if (cached && now < cached.expiresAt) return cached.relay;

        try {
            const result = await queryFn(
                'SELECT marker, destination_url, secret, reply_text FROM inbound_relays WHERE tenant_id = $1 AND is_active = TRUE',
                [tenantId]
            );
            const relay = result.rows[0] || null;
            cache.set(tenantId, { relay, expiresAt: now + ttlMs });
            return relay;
        } catch (err) {
            // A DB blip must not become a relay outage: serve the last known
            // config rather than silently dropping verifications.
            return cached ? cached.relay : null;
        }
    }

    function invalidate(tenantId) {
        if (tenantId) cache.delete(tenantId);
        else cache.clear();
    }

    return { getRelay, invalidate };
}

const defaultService = createInboundRelayConfig();

module.exports = {
    createInboundRelayConfig,
    getRelay: (...args) => defaultService.getRelay(...args),
    invalidateRelay: (...args) => defaultService.invalidate(...args)
};
