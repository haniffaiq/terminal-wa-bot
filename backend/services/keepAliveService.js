const { query } = require('../utils/db');
const { buildMessageHeader, applyHeaderToText } = require('../utils/messageHeader');

const DEFAULT_TICK_MS = 60000;

function buildMessage({ botIds, tenantName, now }) {
    const list = botIds.map(id => `• ${id}`).join('\n');
    const body = `🟢 *Bot masih connect*\n${list}`;
    return applyHeaderToText(body, buildMessageHeader({ tenantName, date: now }));
}

/**
 * Periodic activity so WhatsApp does not treat a silent linked device as dead.
 *
 * Two layers per tick: every connected bot pushes a presence update (a real
 * write on its own websocket, so each session stays warm), then one bot posts a
 * status line to the configured group so the tenant can see it is alive.
 *
 * Sends go straight through the socket rather than the delivery queue — a
 * liveness probe must not depend on Redis or the worker being healthy, and it
 * must not land in delivery stats.
 */
function createKeepAliveService({
    queryFn = query,
    botRegistry,
    logger = console
} = {}) {
    async function findDueTargets(now) {
        const result = await queryFn(
            `SELECT k.id, k.tenant_id, k.group_id, k.interval_minutes, t.name AS tenant_name
             FROM bot_keepalive k
             JOIN tenants t ON t.id = k.tenant_id
             WHERE k.is_active = TRUE
               AND t.is_active = TRUE
               AND (
                   k.last_run_at IS NULL
                   OR k.last_run_at <= $1::timestamp - (k.interval_minutes * INTERVAL '1 minute')
               )`,
            [now.toISOString()]
        );
        return result.rows;
    }

    async function runTarget(target, now) {
        const { id, tenant_id: tenantId, group_id: groupId, tenant_name: tenantName } = target;
        const botIds = botRegistry.getActiveBotIdsForTenant(tenantId);

        if (botIds.length === 0) {
            logger.warn?.(`[KeepAlive] Tenant ${tenantId} has no connected bot; nothing to ping`);
            return { sent: false, pinged: 0 };
        }

        // Presence update on every socket — this is what actually keeps each
        // session from going idle. The group message is only for visibility.
        let pinged = 0;
        for (const botId of botIds) {
            const sock = botRegistry.getBotSocket(tenantId, botId);
            if (!sock) continue;
            try {
                await sock.sendPresenceUpdate('available');
                pinged += 1;
            } catch (err) {
                logger.error(`[KeepAlive] Presence failed for ${botId}: ${err.message}`);
            }
        }

        let sent = false;
        const sender = botRegistry.getNextBotForGroup(groupId, tenantId);
        if (!sender) {
            logger.warn?.(`[KeepAlive] No bot in group ${groupId} (tenant ${tenantId})`);
        } else {
            try {
                await sender.sendMessage(groupId, { text: buildMessage({ botIds, tenantName, now }) });
                sent = true;
            } catch (err) {
                logger.error(`[KeepAlive] Send failed for group ${groupId}: ${err.message}`);
            }
        }

        await queryFn('UPDATE bot_keepalive SET last_run_at = NOW() WHERE id = $1', [id]);
        return { sent, pinged };
    }

    async function tick(now = new Date()) {
        let targets;
        try {
            targets = await findDueTargets(now);
        } catch (err) {
            logger.error(`[KeepAlive] Lookup failed: ${err.message}`);
            return [];
        }

        const results = [];
        for (const target of targets) {
            try {
                const result = await runTarget(target, now);
                results.push({ groupId: target.group_id, ...result });
            } catch (err) {
                logger.error(`[KeepAlive] Target ${target.group_id} failed: ${err.message}`);
            }
        }
        return results;
    }

    return { tick, findDueTargets, runTarget, buildMessage };
}

function startKeepAliveService({
    tickMs = Number(process.env.KEEPALIVE_TICK_MS || DEFAULT_TICK_MS),
    ...options
} = {}) {
    if (tickMs <= 0) return { stop() {} };

    const service = createKeepAliveService(options);
    const timer = setInterval(() => {
        service.tick().catch(err => {
            console.error(`[KeepAlive] Tick failed: ${err.message}`);
        });
    }, tickMs);

    if (typeof timer.unref === 'function') timer.unref();

    return {
        service,
        stop: () => clearInterval(timer)
    };
}

module.exports = { createKeepAliveService, startKeepAliveService, buildMessage };
