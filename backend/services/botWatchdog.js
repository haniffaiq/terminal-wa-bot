const { query } = require('../utils/db');
const botHealthService = require('./botHealthService');

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_BASE_BACKOFF_MS = 60000;
const DEFAULT_MAX_BACKOFF_MS = 900000;

/**
 * Keeps bots connected by acting on TRUE liveness, not on the bot_status column.
 *
 * A WhatsApp socket can die half-open — TCP dead, no close event delivered — so
 * bot_status stays frozen at 'open' and the per-socket reconnect chain never
 * runs. The old watchdog queried `bot_status <> 'open'`, so the one bot that
 * most needed reviving was the row it excluded. admin_bot1 sat dead ~28h: its
 * close event was swallowed by operationBot's generation guard, leaving a dead
 * socket in the registry.
 *
 * Detection is PASSIVE and sends nothing. Baileys runs its own keepalive ping
 * every ~30s (Socket/socket.js) and closes the websocket when the peer stops
 * responding — that is the round-trip that detects half-open. We only READ the
 * result: `sock.ws.isOpen` is true on a live socket and false once Baileys has
 * closed a dead one. So a socket that is present but not open is a dead socket
 * our close handler missed → reconnect. No presence, no outbound: the OTP number
 * stays silent. Bots whose creds were purged (logged out) never appear here.
 */
function createBotWatchdog({
    queryFn = query,
    botRegistry,
    reconnectFn,
    markSuccessFn = botHealthService.markSuccess,
    isSocketAlive = (sock) => sock?.ws?.isOpen === true,
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
            // handshake). Its ws may not be open yet; leave it alone.
            if (botRegistry.isReconnecting?.(tenantId, botId)) {
                skipped.push(key);
                continue;
            }

            const sock = botRegistry.getBotSocket(tenantId, botId);
            if (sock && isSocketAlive(sock)) {
                // Live socket. Refresh last_seen so the dashboard's staleness
                // sweep does not false-flip a healthy bot to offline. This is a
                // DB write only — no WhatsApp traffic.
                clearBackoff(key);
                await safeMarkSuccess(tenantId, botId);
                alive.push(key);
                continue;
            }

            // No socket, or a socket Baileys has already closed (half-open the
            // close handler missed). Reconnect, respecting backoff.
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
    // Passive ticks are fast (no probe waits), but guard reentrancy anyway so a
    // slow DB lookup under load can't overlap two sweeps and corrupt backoff.
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        watchdog.tick()
            .catch(err => console.error(`[BotWatchdog] Tick failed: ${err.message}`))
            .finally(() => { running = false; });
    }, intervalMs);

    if (typeof timer.unref === 'function') timer.unref();

    return {
        watchdog,
        stop: () => clearInterval(timer)
    };
}

module.exports = { createBotWatchdog, startBotWatchdog };
