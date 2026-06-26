const http = require('http');
const pino = require('pino');
const { query } = require('../utils/db');

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname', levelFirst: true }
    },
    level: 'info'
}).child({ service: 'Command' });

// ============================================================
// Message text extraction (moved from adminBot.js)
// ============================================================
function getNestedMessage(message = {}) {
    return message.ephemeralMessage?.message ||
        message.viewOnceMessage?.message ||
        message.viewOnceMessageV2?.message ||
        message.documentWithCaptionMessage?.message ||
        message;
}

function extractMessageText(message) {
    const content = getNestedMessage(message?.message || {});
    const text = content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        '';
    return String(text).trim();
}

// ============================================================
// Dedup: every member-bot receives the same group message with
// the same message.key.id. Claim synchronously (before any await)
// so exactly one handler proceeds. FIFO-capped per tenant.
// ============================================================
const DEDUP_CAP = 500;
const processedIds = new Map(); // tenantId -> { set:Set<string>, queue:string[] }

function claimMessage(tenantId, messageId) {
    if (!tenantId || !messageId) return false;
    let entry = processedIds.get(tenantId);
    if (!entry) {
        entry = { set: new Set(), queue: [] };
        processedIds.set(tenantId, entry);
    }
    if (entry.set.has(messageId)) return false;
    entry.set.add(messageId);
    entry.queue.push(messageId);
    if (entry.queue.length > DEDUP_CAP) {
        const evicted = entry.queue.shift();
        entry.set.delete(evicted);
    }
    return true;
}

function resetDedup() {
    processedIds.clear();
}

// ============================================================
// Responder selection: round-robin among group member bots,
// falling back to the claiming socket for DMs / @c.us / no live bot.
// ============================================================
function selectResponder(chatId, tenantId, sock, deps = {}) {
    if (typeof chatId === 'string' && chatId.endsWith('@g.us') && typeof deps.getNextBotForGroup === 'function') {
        return deps.getNextBotForGroup(chatId, tenantId) || sock;
    }
    return sock;
}

// ============================================================
// Group info (moved from adminBot.js)
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
// Bot status (moved from adminBot.js)
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
// Custom command handler (moved from adminBot.js; queryFn injectable for tests)
// ============================================================
async function handleCustomCommand(sock, chatId, text, tenant, message, queryFn = query) {
    const cmdName = text.split(/\s+/)[0].toLowerCase();
    try {
        const result = await queryFn(
            'SELECT response_template FROM custom_commands WHERE tenant_id = $1 AND command = $2',
            [tenant.id, cmdName]
        );
        if (result.rows.length === 0) return false;

        const template = result.rows[0].response_template;
        let metadata = null;
        try { metadata = await sock.groupMetadata(chatId); } catch (e) {}

        const statusResult = await queryFn(
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
// External API call (moved from adminBot.js)
// ============================================================
function callApi(keyword, type, options = {}) {
    return new Promise((resolve, reject) => {
        const httpClient = options.httpClient || http;
        const baseUrl = options.baseUrl || "http://10.17.7.147:9098/autohealing/api/network_intelligent_api.php";
        const timeoutMs = options.timeoutMs || 15000;
        const params = new URLSearchParams({ keyword, type }).toString();
        const url = `${baseUrl}?${params}`;
        let settled = false;

        function finish(error, data) {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(data);
        }

        const request = httpClient.get(url, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try { finish(null, JSON.parse(data)); } catch (e) { finish(null, { raw: data }); }
            });
        });
        request.on("error", (err) => finish(err));
        if (typeof request.setTimeout === 'function') {
            request.setTimeout(timeoutMs, () => {
                const error = new Error(`Command API timed out after ${timeoutMs}ms`);
                if (typeof request.destroy === 'function') request.destroy(error);
                finish(error);
            });
        }
    });
}

// ============================================================
// Attach command handling to ANY bot socket.
// deps: { getNextBotForGroup, startOperationBot, stopOperationBot,
//         reconnectBot, reconnectSingleBotCommand, getBotStatusList }
// ============================================================
function setupCommands(sock, botId, tenant, deps = {}) {
    const brand = tenant.brand_name;
    const tenantId = tenant.id;

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages?.[0];
        if (!message?.message || !message.key?.remoteJid) return;
        // Ignore our own outgoing messages so a reply that happens to start
        // with '!' can never self-trigger another command.
        if (message.key.fromMe) return;

        const text = extractMessageText(message);
        if (!text) return;
        const commandName = text.split(/\s+/)[0].toLowerCase();
        if (!commandName.startsWith('!')) return;

        // Dedup BEFORE any await — exactly one bot proceeds.
        if (!claimMessage(tenantId, message.key.id)) return;

        const chatId = message.key.remoteJid;
        const responder = selectResponder(chatId, tenantId, sock, deps);

        if (commandName === '!addbot') {
            const [, botName] = text.split(' ');
            if (!botName) return responder.sendMessage(chatId, { text: '*Usage:* !addbot <bot_name>' });
            logger.info(`[${tenantId}] Adding bot: ${botName}`);
            deps.startOperationBot(botName, responder, chatId, tenantId);
            responder.sendMessage(chatId, { text: `*${brand}* Bot *${botName}* is being added. QR code incoming...` });
            return;
        }

        if (commandName === '!rst') {
            const [, botName] = text.split(' ');
            if (!botName) return responder.sendMessage(chatId, { text: '*Usage:* !rst <bot_name>' });
            logger.info(`[${tenantId}] Restarting bot: ${botName}`);
            deps.reconnectSingleBotCommand(botName, tenantId);
            responder.sendMessage(chatId, { text: `*${brand}* Bot *${botName}* is restarting...` });
            return;
        }

        if (commandName === '!rmbot') {
            const [, botNumber] = text.split(' ');
            if (!botNumber) return responder.sendMessage(chatId, { text: '*Usage:* !rmbot <bot_name>' });
            await deps.stopOperationBot(botNumber, tenantId);
            responder.sendMessage(chatId, { text: `*${brand}* Bot *${botNumber}* has been removed.` });
            return;
        }

        if (commandName === '!botstatus') {
            const status = await checkBotStatusForTenant(tenantId, brand);
            responder.sendMessage(chatId, { text: status });
            return;
        }

        if (commandName === '!restart') {
            await deps.reconnectBot(tenantId);
            responder.sendMessage(chatId, { text: `*${brand}* Restarting all bots...` });
            return;
        }

        if (commandName === '!groupid') {
            responder.sendMessage(chatId, { text: `*${brand}* Group ID: ${chatId}` });
            return;
        }

        if (commandName === '!hi' || commandName === '!ho') {
            try {
                const statusMsg = await checkBotStatusForTenant(tenantId, brand);
                await responder.sendMessage(chatId, { text: statusMsg });

                const botList = await deps.getBotStatusList(tenantId, chatId);
                const now = new Date().toLocaleString('id-ID');

                let summary = `╔══════════════════════\n`;
                summary += `║  *${brand} — Health Check*\n`;
                summary += `║  🕐 ${now}\n`;
                summary += `╠══════════════════════\n`;
                summary += `║  🟢 Responding: *${botList.connected.length}* bots\n`;
                summary += `║  🔴 Silent: *${botList.disconnected.length}* bots\n`;
                summary += `╚══════════════════════`;
                await responder.sendMessage(chatId, { text: summary });
            } catch (err) {
                await responder.sendMessage(chatId, { text: '❌ Health check failed.' });
            }
            return;
        }

        if (commandName === '!info') {
            const groupInfo = await getGroupInfo(responder, chatId, brand);
            responder.sendMessage(chatId, { text: groupInfo });
            return;
        }

        if (commandName === '!block') {
            const [, groupId] = text.split(' ');
            if (!groupId) return responder.sendMessage(chatId, { text: '*Usage:* !block <group_id>' });
            responder.sendMessage(chatId, { text: `*${brand}* Group blocked: ${groupId}` });
            return;
        }

        if (commandName === '!open') {
            const [, groupId] = text.split(' ');
            if (!groupId) return responder.sendMessage(chatId, { text: '*Usage:* !open <group_id>' });
            responder.sendMessage(chatId, { text: `*${brand}* Group unblocked: ${groupId}` });
            return;
        }

        if (commandName === '!listblock') {
            responder.sendMessage(chatId, { text: `*${brand}* Block list: _coming soon_` });
            return;
        }

        if (commandName === '!cmd') {
            const parts = text.trim().split(' ');
            if (parts.length < 3) return responder.sendMessage(chatId, { text: '*Usage:* !cmd <type> <keyword>' });
            const cmdType = parts[1];
            const keyword = parts.slice(2).join(' ');
            try {
                const data = await callApi(keyword, cmdType);
                if (data?.result === "OK") {
                    await responder.sendMessage(chatId, { text: `✅ *${brand} CMD*\nType: ${cmdType}\nKeyword: ${keyword}\nStatus: *Sent*` });
                } else {
                    await responder.sendMessage(chatId, { text: `❌ *${brand} CMD*\nType: ${cmdType}\nStatus: *Failed*` });
                }
            } catch (err) {
                await responder.sendMessage(chatId, { text: `❌ *${brand} CMD*\nError: ${err.message}` }).catch(() => {});
            }
            return;
        }

        // Custom commands (DB lookup)
        await handleCustomCommand(responder, chatId, text, tenant, message);
    });
}

module.exports = {
    setupCommands,
    __claimMessageForTests: claimMessage,
    __resetDedupForTests: resetDedup,
    __selectResponderForTests: selectResponder,
    __extractMessageTextForTests: extractMessageText,
    __handleCustomCommandForTests: handleCustomCommand,
    __callApiForTests: callApi,
    __DEDUP_CAP: DEDUP_CAP
};
