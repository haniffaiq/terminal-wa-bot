const { query } = require('../utils/db');
const botHealthService = require('./botHealthService');

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_BASE_BACKOFF_MS = 60000;
const DEFAULT_MAX_BACKOFF_MS = 900000;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Keeps bots connected by acting on TRUE liveness, not on the bot_status column.
 *
 * A WhatsApp socket can die half-open: the TCP connection is dead but no close
 * event ever fires, so bot_status stays frozen at 'open' and the per-socket
 * reconnect chain never runs. bot_health lies the other way — it flips healthy
 * idle bots to 'offline' 120s after connect. And ws.readyState cannot see
 * half-open at all (the local socket still reports OPEN with no FIN/RST).
 *
 * So this walks every creds-holding bot and probes it with a timed
 * sendPresenceUpdate — a real round-trip. Probe succeeds => alive, clear
 * backoff, refresh last_seen. Probe hangs or throws => half-open => reconnect
 * (connectBot tears down the stale socket first). Bots whose creds were purged
 * (logged out) never appear here; they need a QR rescan.
 */
function createBotWatchdog({
    queryFn = query,
    botRegistry,
    reconnectFn,
    markSuccessFn = botHealthService.markSuccess,
    probeBot = (sock) => sock.sendPresenceUpdate('available'),
    probeTimeoutMs = Number(process.env.BOT_WATCHDOG_PROBE_TIMEOUT_MS || DEFAULT_PROBE_TIMEOUT_MS),
    baseBackoffMs = Number(process.env.BOT_WATCHDOG_BASE_BACKOFF_MS || DEFAULT_BASE_BACKOFF_MS),
    maxBackoffMs = Number(process.env.BOT_WATCHDOG_MAX_BACKOFF_MS || DEFAULT_MAX_BACKOFF_MS),
    logger = console
} = {}) {
    const failures = {};
    const nextAllowedAt = {};

    async function findRevivableBots() {
        // Every creds-holding bot in an active tenant — NOT filtered by
        // bot_status, because a half-open dead bot is frozen at 'open' and would
        // be excluded exactly when it most needs reviving.
        const result = await queryFn(
            `SELECT bs.tenant_id, bs.bot_id
             FROM bot_status bs
             JOIN tenants t ON t.id = bs.tenant_id
             WHERE t.is_active = TRUE
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

    // A write to a half-open TCP buffers and never rejects, so a bare probe
    // would hang forever. The timeout is what turns "hanging write" into a
    // "dead" verdict. Any probe failure maps to false; the tick never throws.
    function probeWithTimeout(sock) {
        let timer;
        const probe = Promise.resolve()
            .then(() => probeBot(sock))
            .then(() => true)
            .catch(() => false);
        // Not unref'd: on a half-open probe the timeout is the ONLY thing that
        // resolves the race, so it must keep the loop alive until it fires. It
        // is always cleared below, so it holds the process for at most
        // probeTimeoutMs per in-flight probe.
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), probeTimeoutMs);
        });
        return Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
    }

    function clearBackoff(key) {
        delete failures[key];
        delete nextAllowedAt[key];
    }

    async function safeMarkSuccess(tenantId, botId) {
        try {
            await markSuccessFn({ tenantId, botId });
        } catch (err) {
            logger.error?.(`[BotWatchdog] markSuccess failed for ${botId}: ${err.message}`);
        }
    }

    async function tick(now = Date.now()) {
        let rows;
        try {
            rows = await findRevivableBots();
        } catch (err) {
            logger.error(`[BotWatchdog] Lookup failed: ${err.message}`);
            return { revived: [], skipped: [], alive: [] };
        }

        const revived = [];
        const skipped = [];
        const alive = [];

        for (const { tenant_id: tenantId, bot_id: botId } of rows) {
            const key = `${tenantId}:${botId}`;

            // Mid-reconnect: the socket is settling (e.g. the 515 restart
            // handshake). Probing it would fail and cause thrash; leave it.
            if (botRegistry.isReconnecting?.(tenantId, botId)) {
                skipped.push(key);
                continue;
            }

            const sock = botRegistry.getBotSocket(tenantId, botId);
            if (sock) {
                const isAlive = await probeWithTimeout(sock);
                if (isAlive) {
                    clearBackoff(key);
                    await safeMarkSuccess(tenantId, botId);
                    alive.push(key);
                    continue;
                }
                // Half-open: fall through to reconnect (respecting backoff).
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

        return { revived, skipped, alive };
    }

    function noteConnected(tenantId, botId) {
        clearBackoff(`${tenantId}:${botId}`);
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
