const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const { DisconnectReason } = require('baileys');
const { startOperationBot, stopOperationBot, reconnectBot, getBotStatusList, reconnectSingleBotCommand, updateGroupCache, updateBotStatus } = require('./operationBot');
const { createSock } = require('../utils/createSock');
const { query } = require('../utils/db');
const http = require("http");

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname', levelFirst: true }
    },
    level: 'info'
}).child({ service: 'ADMIN' });

// Store admin bot sockets per tenant: { tenantId: sock }
const adminBots = {};

// ============================================================
// Tenant lookup
// ============================================================
async function getTenantByAdminBot(adminBotId) {
    try {
        const result = await query(
            'SELECT * FROM tenants WHERE admin_bot_id = $1 AND is_active = TRUE',
            [adminBotId]
        );
        return result.rows[0] || null;
    } catch (err) {
        return null;
    }
}

async function getAllActiveTenants() {
    try {
        const result = await query('SELECT * FROM tenants WHERE admin_bot_id IS NOT NULL AND is_active = TRUE');
        return result.rows;
    } catch (err) {
        return [];
    }
}

// ============================================================
// Group info (uses tenant brand)
// ============================================================
async function getGroupInfo(sock, groupId, brand) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        const groupName = metadata.subject || 'Unnamed';
        const memberCount = metadata.participants.length;
        const adminList = metadata.participants
            .filter(p => p.admin)
            .map(p => `  ${p.admin === 'superadmin' ? '👑' : '🔹'} ${p.id.split('@')[0]}`);
        const description = metadata.desc || '_No description_';
        const createdAt = new Date(metadata.creation * 1000).toLocaleString('id-ID');
        const createdBy = metadata.creator ? metadata.creator.split('@')[0] : 'Unknown';

        let msg = `╔══════════════════════\n`;
        msg += `║  *${brand} — Group Info*\n`;
        msg += `╠══════════════════════\n`;
        msg += `║  📌 *${groupName}*\n`;
        msg += `║  🆔 \`${metadata.id}\`\n`;
        msg += `╠══════════════════════\n`;
        msg += `║  👥 Members: *${memberCount}*\n`;
        msg += `║  🛡️ Admins: *${adminList.length}*\n`;
        msg += `${adminList.join('\n')}\n`;
        msg += `╠══════════════════════\n`;
        msg += `║  📝 ${description}\n`;
        msg += `╠══════════════════════\n`;
        msg += `║  📅 Created: ${createdAt}\n`;
        msg += `║  👤 By: ${createdBy}\n`;
        msg += `║  ✏️ Edit: ${metadata.restrict ? 'Admin Only' : 'All Members'}\n`;
        msg += `║  💬 Send: ${metadata.announce ? 'Admin Only' : 'All Members'}\n`;
        msg += `╚══════════════════════`;
        return msg;
    } catch (err) {
        return `❌ Failed to get group info.`;
    }
}

// ============================================================
// Bot status (DB-based, tenant-scoped)
// ============================================================
async function checkBotStatusForTenant(tenantId, brand) {
    try {
        const result = await query(
            'SELECT bot_id, status FROM bot_status WHERE tenant_id = $1 ORDER BY bot_id',
            [tenantId]
        );

        const online = result.rows.filter(r => r.status === 'open').map(r => r.bot_id);
        const offline = result.rows.filter(r => r.status !== 'open').map(r => r.bot_id);
        const total = result.rows.length;
        const now = new Date().toLocaleString('id-ID');

        let msg = `╔══════════════════════\n`;
        msg += `║  *${brand} — Bot Status*\n`;
        msg += `║  📊 ${total} bots registered\n`;
        msg += `║  🕐 ${now}\n`;
        msg += `╠══════════════════════\n`;

        if (online.length > 0) {
            msg += `║  🟢 *Online (${online.length})*\n`;
            online.forEach(b => { msg += `║    ✅ ${b}\n`; });
        } else {
            msg += `║  🟢 *Online:* _none_\n`;
        }

        msg += `╠══════════════════════\n`;

        if (offline.length > 0) {
            msg += `║  🔴 *Offline (${offline.length})*\n`;
            offline.forEach(b => { msg += `║    ❌ ${b}\n`; });
        } else {
            msg += `║  🔴 *Offline:* _none_\n`;
        }

        msg += `╚══════════════════════`;
        return msg;
    } catch (err) {
        return '❌ Failed to read bot status.';
    }
}

// ============================================================
// Custom command handler
// ============================================================
async function handleCustomCommand(sock, chatId, text, tenant, message) {
    const cmdName = text.split(' ')[0];
    try {
        const result = await query(
            'SELECT response_template FROM custom_commands WHERE tenant_id = $1 AND command = $2',
            [tenant.id, cmdName]
        );
        if (result.rows.length === 0) return false;

        const template = result.rows[0].response_template;
        let metadata = null;
        try { metadata = await sock.groupMetadata(chatId); } catch (e) {}

        const statusResult = await query(
            'SELECT COUNT(*) FILTER (WHERE status = \'open\') as online FROM bot_status WHERE tenant_id = $1',
            [tenant.id]
        );
        const onlineCount = statusResult.rows[0]?.online || 0;

        const response = template
            .replace(/\{brand\}/g, tenant.brand_name)
            .replace(/\{date\}/g, new Date().toLocaleDateString('id-ID'))
            .replace(/\{time\}/g, new Date().toLocaleTimeString('id-ID'))
            .replace(/\{group_name\}/g, metadata?.subject || 'Unknown')
            .replace(/\{group_id\}/g, chatId)
            .replace(/\{bot_count\}/g, String(onlineCount))
            .replace(/\{member_count\}/g, String(metadata?.participants?.length || 0))
            .replace(/\{sender\}/g, message.key.participant?.split('@')[0] || message.key.remoteJid?.split('@')[0] || 'Unknown');

        await sock.sendMessage(chatId, { text: response });
        return true;
    } catch (err) {
        logger.error(`Custom command error: ${err.message}`);
        return false;
    }
}

// ============================================================
// External API calls (keep existing)
// ============================================================
function callApi(keyword, type) {
    return new Promise((resolve, reject) => {
        const baseUrl = "http://10.17.7.147:9098/autohealing/api/network_intelligent_api.php";
        const params = new URLSearchParams({ keyword, type }).toString();
        const url = `${baseUrl}?${params}`;
        http.get(url, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
            });
        }).on("error", (err) => reject(err));
    });
}

// ============================================================
// Admin command setup (per tenant)
// ============================================================
function setupAdminCommands(sock, tenant) {
    const brand = tenant.brand_name;
    const tenantId = tenant.id;

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message?.message || !message.key.remoteJid) return;

        const chatId = message.key.remoteJid;
        const text = message.message.conversation || message.message.extendedTextMessage?.text;
        if (!text) return;

        // System commands
        if (text.startsWith('!addbot')) {
            const [, botName] = text.split(' ');
            if (!botName) return sock.sendMessage(chatId, { text: '*Usage:* !addbot <bot_name>' });
            logger.info(`[${tenantId}] Adding bot: ${botName}`);
            startOperationBot(botName, sock, chatId, tenantId);
            sock.sendMessage(chatId, { text: `*${brand}* Bot *${botName}* is being added. QR code incoming...` });
            return;
        }

        if (text.startsWith('!rst')) {
            const [, botName] = text.split(' ');
            if (!botName) return sock.sendMessage(chatId, { text: '*Usage:* !rst <bot_name>' });
            logger.info(`[${tenantId}] Restarting bot: ${botName}`);
            reconnectSingleBotCommand(botName, tenantId);
            sock.sendMessage(chatId, { text: `*${brand}* Bot *${botName}* is restarting...` });
            return;
        }

        if (text.startsWith('!rmbot')) {
            const [, botNumber] = text.split(' ');
            if (!botNumber) return sock.sendMessage(chatId, { text: '*Usage:* !rmbot <bot_name>' });
            await stopOperationBot(botNumber, tenantId);
            sock.sendMessage(chatId, { text: `*${brand}* Bot *${botNumber}* has been removed.` });
            return;
        }

        if (text.startsWith('!botstatus')) {
            const status = await checkBotStatusForTenant(tenantId, brand);
            sock.sendMessage(chatId, { text: status });
            return;
        }

        if (text.startsWith('!restart')) {
            await reconnectBot(tenantId);
            sock.sendMessage(chatId, { text: `*${brand}* Restarting all operation bots...` });
            return;
        }

        if (text === '!groupid') {
            sock.sendMessage(chatId, { text: `*${brand}* Group ID: ${chatId}` });
            return;
        }

        if (text === '!hi' || text === '!ho') {
            try {
                const statusMsg = await checkBotStatusForTenant(tenantId, brand);
                await sock.sendMessage(chatId, { text: statusMsg });

                const botList = await getBotStatusList(tenantId, chatId);
                const now = new Date().toLocaleString('id-ID');

                let summary = `╔══════════════════════\n`;
                summary += `║  *${brand} — Health Check*\n`;
                summary += `║  🕐 ${now}\n`;
                summary += `╠══════════════════════\n`;
                summary += `║  🟢 Responding: *${botList.connected.length}* bots\n`;
                summary += `║  🔴 Silent: *${botList.disconnected.length}* bots\n`;
                summary += `╚══════════════════════`;
                await sock.sendMessage(chatId, { text: summary });
            } catch (err) {
                await sock.sendMessage(chatId, { text: '❌ Health check failed.' });
            }
            return;
        }

        if (text === '!info') {
            const groupInfo = await getGroupInfo(sock, chatId, brand);
            sock.sendMessage(chatId, { text: groupInfo });
            return;
        }

        if (text.startsWith('!block')) {
            const [, groupId] = text.split(' ');
            if (!groupId) return sock.sendMessage(chatId, { text: '*Usage:* !block <group_id>' });
            // TODO: tenant-scoped block list in DB
            sock.sendMessage(chatId, { text: `*${brand}* Group blocked: ${groupId}` });
            return;
        }

        if (text.startsWith('!open')) {
            const [, groupId] = text.split(' ');
            if (!groupId) return sock.sendMessage(chatId, { text: '*Usage:* !open <group_id>' });
            sock.sendMessage(chatId, { text: `*${brand}* Group unblocked: ${groupId}` });
            return;
        }

        if (text === '!listblock') {
            sock.sendMessage(chatId, { text: `*${brand}* Block list: _coming soon_` });
            return;
        }

        if (text.startsWith('!cmd')) {
            const parts = text.trim().split(' ');
            if (parts.length < 3) return sock.sendMessage(chatId, { text: '*Usage:* !cmd <type> <keyword>' });
            const cmdType = parts[1];
            const keyword = parts.slice(2).join(' ');
            try {
                const data = await callApi(keyword, cmdType);
                if (data?.result === "OK") {
                    await sock.sendMessage(chatId, { text: `✅ *${brand} CMD*\nType: ${cmdType}\nKeyword: ${keyword}\nStatus: *Sent*` });
                } else {
                    await sock.sendMessage(chatId, { text: `❌ *${brand} CMD*\nType: ${cmdType}\nStatus: *Failed*` });
                }
            } catch (err) {
                await sock.sendMessage(chatId, { text: `❌ *${brand} CMD*\nError: ${err.message}` }).catch(() => {});
            }
            return;
        }

        // Custom commands (check DB)
        if (text.startsWith('!')) {
            await handleCustomCommand(sock, chatId, text, tenant, message);
        }
    });
}

// ============================================================
// Start admin bot for a single tenant
// ============================================================
async function startSingleAdminBot(tenant) {
    const botId = tenant.admin_bot_id;
    const tenantId = tenant.id;

    logger.info(`[${tenantId}] Starting admin bot: ${botId}`);

    try {
        const { sock } = await createSock(botId, tenantId);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                try {
                    const qrPath = path.join(__dirname, '..', 'auth_sessions', tenantId, `${botId}.png`);
                    if (!fs.existsSync(path.dirname(qrPath))) fs.mkdirSync(path.dirname(qrPath), { recursive: true });
                    qrcodeTerminal.generate(qr, { small: true });
                    await qrcode.toFile(qrPath, qr);
                    logger.info(`[${tenantId}] QR saved for admin bot ${botId}`);
                } catch (err) {
                    logger.error(`[${tenantId}] QR error: ${err.message}`);
                }
            }

            if (connection === 'open') {
                logger.info(`[${tenantId}] Admin bot ${botId} connected.`);
                adminBots[tenantId] = sock;
                await updateBotStatus(botId, 'open', tenantId);
                await updateGroupCache(botId, sock, tenantId);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`[${tenantId}] Admin bot disconnected. Reason: ${reason}`);
                await updateBotStatus(botId, 'close', tenantId);

                if (reason !== DisconnectReason.loggedOut) {
                    logger.info(`[${tenantId}] Admin bot reconnecting in 10s...`);
                    setTimeout(() => startSingleAdminBot(tenant), 10000);
                } else {
                    logger.error(`[${tenantId}] Admin bot logged out. QR scan required.`);
                }
            }
        });

        setupAdminCommands(sock, tenant);
        return sock;
    } catch (error) {
        logger.error(`[${tenantId}] Failed to start admin bot: ${error.message}`);
        setTimeout(() => startSingleAdminBot(tenant), 10000);
    }
}

// ============================================================
// Start all admin bots (called on server startup)
// ============================================================
async function startAdminBots() {
    // First reconnect all operation bots
    await reconnectBot();

    const tenants = await getAllActiveTenants();
    logger.info(`Starting admin bots for ${tenants.length} tenants...`);

    for (const tenant of tenants) {
        await startSingleAdminBot(tenant);
        await new Promise(r => setTimeout(r, 3000));
    }

    logger.info('All admin bots started.');
}

// Keep backward compat — old name
async function startAdminBot() {
    return startAdminBots();
}

module.exports = { startAdminBot, startAdminBots, startSingleAdminBot, checkBotStatusForTenant };
