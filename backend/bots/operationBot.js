const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const { DisconnectReason } = require('baileys');
const { createSock } = require('../utils/createSock');
const { query } = require('../utils/db');
const botHealthService = require('../services/botHealthService');

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname', levelFirst: true }
    },
    level: 'info'
}).child({ service: 'Operation' });

// Tenant-keyed maps: { tenantId: { botId: value } }
let operationBots = {};
let groupBots = {};
let groupCache = {};
const reconnectTimers = {};
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 10000;

// Helper: ensure tenant maps exist
function ensureTenant(tenantId) {
    if (!operationBots[tenantId]) operationBots[tenantId] = {};
    if (!groupBots[tenantId]) groupBots[tenantId] = {};
    if (!groupCache[tenantId]) groupCache[tenantId] = new Map();
}

// DB-based bot status
async function getBotStatusMap(tenantId) {
    try {
        const result = await query('SELECT bot_id, status FROM bot_status WHERE tenant_id = $1', [tenantId]);
        const map = {};
        result.rows.forEach(r => { map[r.bot_id] = r.status; });
        return map;
    } catch (err) {
        return {};
    }
}

async function updateBotStatus(botId, status, tenantId) {
    try {
        await query(
            `INSERT INTO bot_status (tenant_id, bot_id, status, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (tenant_id, bot_id) DO UPDATE SET status = $3, updated_at = NOW()`,
            [tenantId, botId, status]
        );
    } catch (err) {
        console.error('Bot status DB error:', err.message);
    }

    try {
        if (status === 'open') {
            await botHealthService.markOnline({ tenantId, botId });
        } else if (status === 'close') {
            await botHealthService.markOffline({ tenantId, botId });
        }
    } catch (err) {
        console.error('Bot health DB error:', err.message);
    }

    if (status === 'open' || status === 'close') {
        try {
            const { io } = require('../index');
            if (io && tenantId) {
                io.to(`tenant:${tenantId}`).emit('bot:status', { botId, status, timestamp: new Date().toISOString() });
                io.to('super_admin').emit('bot:status', { botId, status, tenantId, timestamp: new Date().toISOString() });
            }
        } catch (e) {}
    }
}

// Group cache management
async function updateGroupCache(botId, sock, tenantId) {
    ensureTenant(tenantId);
    try {
        const groups = Object.values(await sock.groupFetchAllParticipating());
        groups.forEach((group) => {
            if (!groupBots[tenantId][group.id]) groupBots[tenantId][group.id] = [];
            if (!groupBots[tenantId][group.id].includes(botId)) groupBots[tenantId][group.id].push(botId);

            const cache = groupCache[tenantId];
            const existing = cache.get(group.id);
            if (existing) {
                existing.name = group.subject || existing.name;
                existing.member_count = group.participants.length;
                if (!existing.bots.includes(botId)) existing.bots.push(botId);
            } else {
                cache.set(group.id, {
                    id: group.id,
                    name: group.subject || '',
                    member_count: group.participants.length,
                    bots: [botId]
                });
            }
        });
        logger.info(`[${botId}] Registered in ${groups.length} groups (tenant ${tenantId})`);
    } catch (err) {
        logger.error(`[${botId}] Failed to fetch groups: ${err.message}`);
    }
}

function getAllGroups(tenantId) {
    if (!tenantId || !groupCache[tenantId]) return [];
    return Array.from(groupCache[tenantId].values());
}

// Core connect function
async function connectBot(botId, opts = {}) {
    const { adminSock, chatId, tenantId, attempt = 0 } = opts;
    const timerKey = `${tenantId}:${botId}`;

    if (!tenantId) {
        logger.error(`[${botId}] Cannot connect without tenantId`);
        return null;
    }

    ensureTenant(tenantId);

    if (reconnectTimers[timerKey] === 'connecting') {
        logger.warn(`[${botId}] Already connecting, skipping.`);
        return null;
    }

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${botId}] Max reconnect attempts reached.`);
        await updateBotStatus(botId, 'close', tenantId);
        return null;
    }

    if (operationBots[tenantId][botId]) {
        try { await operationBots[tenantId][botId].end(); } catch (e) {}
        delete operationBots[tenantId][botId];
    }

    if (reconnectTimers[timerKey] && reconnectTimers[timerKey] !== 'connecting') {
        clearTimeout(reconnectTimers[timerKey]);
        delete reconnectTimers[timerKey];
    }

    reconnectTimers[timerKey] = 'connecting';

    // Auth sessions scoped by tenant
    const authFolder = path.join(__dirname, '..', 'auth_sessions', tenantId, botId);
    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    try {
        logger.info(`[${botId}] Connecting (attempt ${attempt + 1}, tenant ${tenantId})...`);
        const { sock } = await createSock(botId, tenantId);

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr && adminSock && chatId) {
                try {
                    const qrPath = path.join(__dirname, '..', 'auth_sessions', tenantId, `${botId}.png`);
                    await qrcode.toFile(qrPath, qr);
                    const imageBuffer = fs.readFileSync(qrPath);
                    await adminSock.sendMessage(chatId, {
                        image: imageBuffer,
                        caption: `Scan QR Code for bot ${botId}`
                    });
                } catch (err) {
                    logger.error(`[${botId}] Failed to send QR: ${err.message}`);
                }
            }

            if (connection === 'open') {
                logger.info(`[${botId}] Connected (tenant ${tenantId}).`);
                operationBots[tenantId][botId] = sock;
                await updateBotStatus(botId, 'open', tenantId);
                delete reconnectTimers[timerKey];

                if (adminSock && chatId) {
                    try {
                        await adminSock.sendMessage(chatId, { text: `Bot ${botId} connected.` });
                    } catch (e) {}
                }

                await updateGroupCache(botId, sock, tenantId);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                logger.warn(`[${botId}] Disconnected (reason: ${statusCode}, tenant ${tenantId}).`);
                await updateBotStatus(botId, 'close', tenantId);
                if (operationBots[tenantId]) delete operationBots[tenantId][botId];
                delete reconnectTimers[timerKey];

                if (statusCode === DisconnectReason.loggedOut) {
                    logger.error(`[${botId}] Logged out. Session cleared.`);
                    const sessFolder = path.join(__dirname, '..', 'auth_sessions', tenantId, botId);
                    if (fs.existsSync(sessFolder)) {
                        fs.rmSync(sessFolder, { recursive: true, force: true });
                    }
                    if (groupBots[tenantId]) {
                        for (const gId of Object.keys(groupBots[tenantId])) {
                            groupBots[tenantId][gId] = groupBots[tenantId][gId].filter(b => b !== botId);
                        }
                    }
                } else {
                    const delay = RECONNECT_DELAY * (attempt + 1);
                    logger.info(`[${botId}] Will reconnect in ${delay / 1000}s...`);
                    reconnectTimers[timerKey] = setTimeout(() => {
                        connectBot(botId, { adminSock, chatId, tenantId, attempt: attempt + 1 });
                    }, delay);
                }
            }
        });

        return sock;
    } catch (err) {
        logger.error(`[${botId}] Connect error: ${err.message}`);
        delete reconnectTimers[timerKey];

        const delay = RECONNECT_DELAY * (attempt + 1);
        reconnectTimers[timerKey] = setTimeout(() => {
            connectBot(botId, { adminSock, chatId, tenantId, attempt: attempt + 1 });
        }, delay);
        return null;
    }
}

// Public API
async function startOperationBot(botId, adminSock, chatId, tenantId) {
    return connectBot(botId, { adminSock, chatId, tenantId });
}

async function reconnectSingleBot(botId, tenantId) {
    return connectBot(botId, { tenantId });
}

async function reconnectSingleBotCommand(botId, tenantId) {
    return connectBot(botId, { tenantId });
}

async function reconnectSingleBotAPI(botId, tenantId) {
    return connectBot(botId, { tenantId });
}

async function startOperationBotAPI(botId, tenantId) {
    if (!tenantId) return null;
    ensureTenant(tenantId);
    let qrBase64 = null;

    try {
        const { sock } = await createSock(botId, tenantId);

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                try {
                    const qrPath = path.join(__dirname, '..', 'auth_sessions', tenantId, `${botId}.png`);
                    if (!fs.existsSync(path.dirname(qrPath))) fs.mkdirSync(path.dirname(qrPath), { recursive: true });
                    await qrcode.toFile(qrPath, qr);
                    const imageBuffer = fs.readFileSync(qrPath);
                    qrBase64 = `data:image/png;base64,${imageBuffer.toString('base64')}`;
                } catch (err) {
                    logger.error(`[${botId}] QR error: ${err.message}`);
                }
            }

            if (connection === 'open') {
                logger.info(`[${botId}] Connected via API (tenant ${tenantId}).`);
                operationBots[tenantId][botId] = sock;
                await updateBotStatus(botId, 'open', tenantId);
                await updateGroupCache(botId, sock, tenantId);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                await updateBotStatus(botId, 'close', tenantId);
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(() => connectBot(botId, { tenantId }), RECONNECT_DELAY);
                }
            }
        });

        return new Promise((resolve) => {
            const checkQR = setInterval(() => {
                if (qrBase64) { clearInterval(checkQR); resolve(qrBase64); }
            }, 500);
            setTimeout(() => { clearInterval(checkQR); resolve(null); }, 15000);
        });
    } catch (error) {
        logger.error(`[${botId}] API start error: ${error.message}`);
        return null;
    }
}

// Reconnect all bots for a tenant (or all tenants if tenantId is null)
let isReconnecting = false;

async function reconnectBot(tenantId) {
    if (isReconnecting) return;
    isReconnecting = true;

    try {
        let result;
        if (tenantId) {
            result = await query(
                'SELECT bot_id, tenant_id FROM bot_status WHERE tenant_id = $1 AND is_admin_bot = FALSE',
                [tenantId]
            );
        } else {
            result = await query('SELECT bot_id, tenant_id FROM bot_status WHERE is_admin_bot = FALSE');
        }

        logger.info(`Reconnecting ${result.rows.length} operation bots...`);

        for (const row of result.rows) {
            await connectBot(row.bot_id, { tenantId: row.tenant_id });
            await new Promise(r => setTimeout(r, 3000));
        }
    } catch (err) {
        logger.error(`Reconnect failed: ${err.message}`);
    }

    isReconnecting = false;
}

// Bot selection
function getNextBotForGroup(groupId, tenantId) {
    if (!tenantId || !groupBots[tenantId]) return null;
    const activeBots = groupBots[tenantId][groupId] || [];
    if (activeBots.length === 0) return null;

    // Sync filter — use in-memory status
    const filtered = activeBots.filter(botId => operationBots[tenantId]?.[botId]);
    if (filtered.length === 0) return null;

    const nextBotId = filtered[0];
    const index = activeBots.indexOf(nextBotId);
    if (index !== -1) {
        activeBots.splice(index, 1);
        activeBots.push(nextBotId);
    }
    groupBots[tenantId][groupId] = activeBots;
    return operationBots[tenantId][nextBotId];
}

function getActiveGroupBotIds(tenantId, groupId) {
    if (!tenantId || !groupBots[tenantId]) return [];
    const activeBots = groupBots[tenantId][groupId] || [];
    return activeBots.filter(botId => operationBots[tenantId]?.[botId]);
}

function getBotSocket(tenantId, botId) {
    if (!tenantId || !botId) return null;
    return operationBots[tenantId]?.[botId] || null;
}

function getNextBotForIndividual(number, tenantId) {
    if (!tenantId || !operationBots[tenantId]) return null;
    const botIds = Object.keys(operationBots[tenantId]);
    if (botIds.length === 0) return null;
    return operationBots[tenantId][botIds[0]];
}

async function disconnectBotForce(botId, tenantId) {
    if (!tenantId || !operationBots[tenantId]?.[botId]) {
        return { success: false, message: 'Bot not active' };
    }

    const timerKey = `${tenantId}:${botId}`;
    if (reconnectTimers[timerKey] && reconnectTimers[timerKey] !== 'connecting') {
        clearTimeout(reconnectTimers[timerKey]);
        delete reconnectTimers[timerKey];
    }

    try {
        await operationBots[tenantId][botId].end();
        delete operationBots[tenantId][botId];
        await updateBotStatus(botId, 'close', tenantId);
        return { success: true, message: 'Disconnected' };
    } catch (err) {
        return { success: false, message: 'Failed to disconnect', error: err.toString() };
    }
}

async function getBotStatusList(tenantId, target) {
    try {
        const result = await query(
            'SELECT bot_id, status FROM bot_status WHERE tenant_id = $1 AND is_admin_bot = FALSE',
            [tenantId]
        );

        const connected = [];
        const disconnected = [];

        for (const row of result.rows) {
            if (row.status === 'open' && operationBots[tenantId]?.[row.bot_id]) {
                connected.push(row.bot_id);
                if (target) {
                    try {
                        await operationBots[tenantId][row.bot_id].sendMessage(target, { text: `✅ *${row.bot_id}* — responding` });
                    } catch (err) {}
                }
            } else {
                disconnected.push(row.bot_id);
            }
        }
        return { connected, disconnected };
    } catch (err) {
        return { connected: [], disconnected: [] };
    }
}

function getOperationSock(tenantId) {
    if (!tenantId) return groupBots;
    return groupBots[tenantId] || null;
}

async function stopOperationBot(botId, tenantId) {
    const timerKey = `${tenantId}:${botId}`;
    if (reconnectTimers[timerKey] && reconnectTimers[timerKey] !== 'connecting') {
        clearTimeout(reconnectTimers[timerKey]);
        delete reconnectTimers[timerKey];
    }

    // Disconnect socket
    if (operationBots[tenantId]?.[botId]) {
        try { await operationBots[tenantId][botId].end(); } catch (err) {}
        delete operationBots[tenantId][botId];
    }

    // Remove from group cache
    if (groupBots[tenantId]) {
        for (const gId of Object.keys(groupBots[tenantId])) {
            groupBots[tenantId][gId] = groupBots[tenantId][gId].filter(b => b !== botId);
        }
    }

    // If this was the admin bot, stop it properly and clear admin_bot_id
    try {
        const tenantResult = await query('SELECT admin_bot_id FROM tenants WHERE id = $1', [tenantId]);
        if (tenantResult.rows.length > 0 && tenantResult.rows[0].admin_bot_id === botId) {
            const { stopAdminBot } = require('./adminBot');
            await stopAdminBot(tenantId);
            await query('UPDATE tenants SET admin_bot_id = NULL WHERE id = $1', [tenantId]);
            logger.info(`[${botId}] Admin bot cleared for tenant ${tenantId}`);
        }
    } catch (err) {}

    // Delete from DB: bot_status + auth_sessions
    try {
        await query('DELETE FROM bot_status WHERE tenant_id = $1 AND bot_id = $2', [tenantId, botId]);
        await query('DELETE FROM auth_sessions WHERE tenant_id = $1 AND bot_id = $2', [tenantId, botId]);
        logger.info(`[${botId}] Deleted bot_status + auth_sessions from DB (tenant ${tenantId})`);
    } catch (err) {
        logger.error(`[${botId}] DB cleanup error: ${err.message}`);
    }

    return true;
}

module.exports = {
    startOperationBot,
    getOperationSock,
    stopOperationBot,
    reconnectBot,
    getNextBotForGroup,
    getActiveGroupBotIds,
    getBotSocket,
    startOperationBotAPI,
    getBotStatusList,
    reconnectSingleBot,
    reconnectSingleBotCommand,
    reconnectSingleBotAPI,
    disconnectBotForce,
    getNextBotForIndividual,
    getAllGroups,
    updateGroupCache,
    updateBotStatus
};
