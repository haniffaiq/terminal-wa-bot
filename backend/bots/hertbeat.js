const { query } = require('../utils/db');

// Heartbeat — checks bot status from DB, grouped by tenant
function checkHeartbeatFromDB() {
    setInterval(async () => {
        try {
            const result = await query(`
                SELECT t.name as tenant_name, t.id as tenant_id,
                       bs.bot_id, bs.status, bs.is_admin_bot, bs.updated_at
                FROM bot_status bs
                JOIN tenants t ON bs.tenant_id = t.id
                WHERE t.is_active = TRUE
                ORDER BY t.name, bs.bot_id
            `);

            if (result.rows.length === 0) return;

            // Group by tenant
            const tenants = {};
            for (const row of result.rows) {
                if (!tenants[row.tenant_name]) {
                    tenants[row.tenant_name] = { online: [], offline: [] };
                }
                if (row.status === 'open') {
                    tenants[row.tenant_name].online.push(row.bot_id);
                } else {
                    tenants[row.tenant_name].offline.push(row.bot_id);
                }
            }

            // Log per tenant
            const summary = Object.entries(tenants).map(([name, data]) => {
                return `[${name}] online=${data.online.length} offline=${data.offline.length}`;
            }).join(' | ');

            console.log(`[Heartbeat] ${summary}`);

        } catch (err) {
            // DB not ready yet, silently skip
        }
    }, 30000); // Every 30 seconds
}

module.exports = { checkHeartbeatFromFile: checkHeartbeatFromDB, checkHeartbeatFromDB };
