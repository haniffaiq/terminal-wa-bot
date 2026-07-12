const { query } = require('../utils/db');

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_BASE_BACKOFF_MS = 60000;
const DEFAULT_MAX_BACKOFF_MS = 900000;

/**
 * Revives bots that are stuck at status='close'.
 *
 * The per-socket reconnect chain in operationBot dies whenever the process
 * restarts mid-close, the retry budget runs out, or a close event is missed —
 * and nothing else ever retries. Bots that still hold auth creds sit offline
 * until a human clicks Reconnect. This walks the DB and restarts them.
 *
 * Bots whose creds were purged (logged out) are skipped: they need a QR rescan,
 * and reconnecting them would just spin against a dead session.
 */
function createBotWatchdog({
    queryFn = query,
    botRegistry,
    reconnectFn,
    baseBackoffMs = Number(process.env.BOT_WATCHDOG_BASE_BACKOFF_MS || DEFAULT_BASE_BACKOFF_MS),
    maxBackoffMs = Number(process.env.BOT_WATCHDOG_MAX_BACKOFF_MS || DEFAULT_MAX_BACKOFF_MS),
    logger = console
} = {}) {
    const failures = {};
    const nextAllowedAt = {};

    async function findRevivableBots() {
        const result = await queryFn(
            `SELECT bs.tenant_id, bs.bot_id
             FROM bot_status bs
             JOIN tenants t ON t.id = bs.tenant_id
             WHERE t.is_active = TRUE
               AND bs.status <> 'open'
               AND EXISTS (
                   SELECT 1 FROM auth_sessions a
                   WHERE a.tenant_id = bs.tenant_id::text
                     AND a.bot_id = bs.bot_id
                     AND a.key_name = 'creds'
               )
             ORDER BY bs.updated_at ASC`
        );
        return result.rows;
    }

    function backoffFor(key) {
        const count = failures[key] || 0;
        return Math.min(baseBackoffMs * Math.pow(2, count), maxBackoffMs);
    }

    async function tick(now = Date.now()) {
        let rows;
        try {
            rows = await findRevivableBots();
        } catch (err) {
            logger.error(`[BotWatchdog] Lookup failed: ${err.message}`);
            return { revived: [], skipped: [] };
        }

        const revived = [];
        const skipped = [];

        for (const { tenant_id: tenantId, bot_id: botId } of rows) {
            const key = `${tenantId}:${botId}`;

            // Socket is live in memory — the DB row is just stale, leave it alone.
            if (botRegistry.getBotSocket(tenantId, botId)) {
                delete failures[key];
                delete nextAllowedAt[key];
                continue;
            }

            if (nextAllowedAt[key] && now < nextAllowedAt[key]) {
                skipped.push(key);
                continue;
            }

            logger.log?.(`[BotWatchdog] Reviving ${botId} (tenant ${tenantId})`);
            try {
                await reconnectFn(botId, tenantId);
                failures[key] = (failures[key] || 0) + 1;
                nextAllowedAt[key] = now + backoffFor(key);
                revived.push(key);
            } catch (err) {
                failures[key] = (failures[key] || 0) + 1;
                nextAllowedAt[key] = now + backoffFor(key);
                logger.error(`[BotWatchdog] Failed to revive ${botId}: ${err.message}`);
            }
        }

        return { revived, skipped };
    }

    function noteConnected(tenantId, botId) {
        const key = `${tenantId}:${botId}`;
        delete failures[key];
        delete nextAllowedAt[key];
    }

    return { tick, noteConnected, findRevivableBots };
}

function startBotWatchdog({
    intervalMs = Number(process.env.BOT_WATCHDOG_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    ...options
} = {}) {
    if (intervalMs <= 0) return { stop() {} };

    const watchdog = createBotWatchdog(options);
    const timer = setInterval(() => {
        watchdog.tick().catch(err => {
            console.error(`[BotWatchdog] Tick failed: ${err.message}`);
        });
    }, intervalMs);

    if (typeof timer.unref === 'function') timer.unref();

    return {
        watchdog,
        stop: () => clearInterval(timer)
    };
}

module.exports = { createBotWatchdog, startBotWatchdog };
