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
let routingReadyAt = {};
let routingWaiters = [];
let routingExpectedBots = {};
const reconnectTimers = {};
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 10000;

function createOperationSocketGenerationTracker() {
    const generations = {};

    return {
        next(tenantId, botId) {
            const key = `${tenantId}:${botId}`;
            generations[key] = (generations[key] || 0) + 1;
            return generations[key];
        },
        isCurrent(tenantId, botId, generation) {
            return generations[`${tenantId}:${botId}`] === generation;
        }
    };
}

const operationSocketGenerations = createOperationSocketGenerationTracker();
const groupRefreshTimers = {};

// Helper: ensure tenant maps exist
function ensureTenant(tenantId) {
    if (!operationBots[tenantId]) operationBots[tenantId] = {};
    if (!groupBots[tenantId]) groupBots[tenantId] = {};
    if (!groupCache[tenantId]) groupCache[tenantId] = new Map();
    if (!routingExpectedBots[tenantId]) routingExpectedBots[tenantId] = new Set();
}

function getTimerTenants() {
    return Object.keys(reconnectTimers)
        .map(key => key.split(':')[0])
        .filter(Boolean);
}

function getRoutingTenantIds() {
    return [...new Set([
        ...Object.keys(operationBots),
        ...Object.keys(groupBots),
        ...Object.keys(groupCache),
        ...Object.keys(routingExpectedBots),
        ...getTimerTenants()
    ])];
}

function hasExpectedRoutingBot(tenantId) {
    if (!tenantId) return false;
    return Boolean(routingExpectedBots[tenantId] && routingExpectedBots[tenantId].size > 0);
}

function isRoutingReady(tenantId = null) {
    if (tenantId) {
        return !hasExpectedRoutingBot(tenantId);
    }

    const tenantIds = getRoutingTenantIds();
    if (tenantIds.length === 0) return true;
    return tenantIds.every(id => isRoutingReady(id));
}

function resolveRoutingWaiters() {
    const remaining = [];
    for (const waiter of routingWaiters) {
        if (isRoutingReady(waiter.tenantId)) {
            clearTimeout(waiter.timer);
            waiter.resolve({ ready: true, timedOut: false });
        } else {
            remaining.push(waiter);
        }
    }
    routingWaiters = remaining;
}

function markRoutingExpected(tenantId, botId) {
    if (!tenantId || !botId) return;
    ensureTenant(tenantId);
    routingExpectedBots[tenantId].add(botId);
    delete routingReadyAt[tenantId];
    resolveRoutingWaiters();
}

function clearRoutingExpected(tenantId, botId) {
    if (!tenantId || !botId || !routingExpectedBots[tenantId]) return;
    routingExpectedBots[tenantId].delete(botId);
    if (routingExpectedBots[tenantId].size === 0) {
        markRoutingReady(tenantId);
        return;
    }
    resolveRoutingWaiters();
}

function markRoutingReady(tenantId) {
    if (!tenantId) return;
    if (hasExpectedRoutingBot(tenantId)) return;
    routingReadyAt[tenantId] = Date.now();
    resolveRoutingWaiters();
}

function waitForRoutingReady({ tenantId = null, timeoutMs = 30000 } = {}) {
    if (isRoutingReady(tenantId)) {
        return Promise.resolve({ ready: true, timedOut: false });
    }

    return new Promise(resolve => {
        const waiter = {
            tenantId,
            resolve,
            timer: setTimeout(() => {
                routingWaiters = routingWaiters.filter(item => item !== waiter);
                resolve({ ready: isRoutingReady(tenantId), timedOut: true });
            }, Math.max(0, timeoutMs))
        };
        routingWaiters.push(waiter);
    });
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

async function isAdminBotRecord(botId, tenantId, queryFn = query) {
    if (!botId || !tenantId) return false;

    try {
        const result = await queryFn(
            'SELECT is_admin_bot FROM bot_status WHERE tenant_id = $1 AND bot_id = $2',
            [tenantId, botId]
        );
        return result.rows[0]?.is_admin_bot === true;
    } catch (err) {
        logger.warn(`[${botId}] Failed to verify admin bot flag: ${err.message}`);
        return false;
    }
}

function removeAuthSessionFiles(botId, tenantId, baseDir = path.join(__dirname, '..', 'auth_sessions')) {
    if (!botId || !tenantId) return;

    const sessionFolder = path.join(baseDir, tenantId, botId);
    const qrPath = path.join(baseDir, tenantId, `${botId}.png`);

    for (const targetPath of [sessionFolder, qrPath]) {
        try {
            if (fs.existsSync(targetPath)) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            }
        } catch (err) {
            logger.warn(`[${botId}] Failed to remove auth session file ${targetPath}: ${err.message}`);
        }
    }
}

async function deleteBotRecords(botId, tenantId, queryFn = query) {
    await queryFn('DELETE FROM bot_group_routes WHERE tenant_id = $1 AND bot_id = $2', [tenantId, botId]);
    await queryFn('DELETE FROM bot_health WHERE tenant_id = $1 AND bot_id = $2', [tenantId, botId]);
    await queryFn('DELETE FROM auth_sessions WHERE tenant_id = $1 AND bot_id = $2', [tenantId, botId]);
    await queryFn('DELETE FROM bot_status WHERE tenant_id = $1 AND bot_id = $2', [tenantId, botId]);
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
        const activeGroupIds = new Set(groups.map(group => group.id));

        for (const groupId of Object.keys(groupBots[tenantId])) {
            groupBots[tenantId][groupId] = groupBots[tenantId][groupId].filter(id => id !== botId);
            if (groupBots[tenantId][groupId].length === 0) {
                delete groupBots[tenantId][groupId];
            }
        }

        for (const [groupId, cachedGroup] of groupCache[tenantId].entries()) {
            cachedGroup.bots = (cachedGroup.bots || []).filter(id => id !== botId);
            if (!activeGroupIds.has(groupId) && cachedGroup.bots.length === 0) {
                groupCache[tenantId].delete(groupId);
            }
        }

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
        if (operationBots[tenantId]?.[botId] || routingExpectedBots[tenantId]?.has(botId)) {
            clearRoutingExpected(tenantId, botId);
            markRoutingReady(tenantId);
        }
    } catch (err) {
        logger.error(`[${botId}] Failed to fetch groups: ${err.message}`);
    }
}

function scheduleGroupCacheRefresh(botId, sock, tenantId, reason = 'group-event', delayMs = 1000) {
    if (!botId || !sock || !tenantId) return;
    const timerKey = `${tenantId}:${botId}`;

    if (groupRefreshTimers[timerKey]) {
        clearTimeout(groupRefreshTimers[timerKey]);
    }

    groupRefreshTimers[timerKey] = setTimeout(async () => {
        delete groupRefreshTimers[timerKey];
        logger.info(`[${botId}] Refreshing group cache after ${reason} (tenant ${tenantId})`);
        await updateGroupCache(botId, sock, tenantId);
    }, delayMs);

    if (typeof groupRefreshTimers[timerKey].unref === 'function') {
        groupRefreshTimers[timerKey].unref();
    }
}

function registerGroupCacheRefreshHandlers(botId, sock, tenantId, scheduleFn = scheduleGroupCacheRefresh) {
    if (!sock?.ev?.on) return;
    const refresh = (reason) => () => scheduleFn(botId, sock, tenantId, reason);

    sock.ev.on('groups.upsert', refresh('groups.upsert'));
    sock.ev.on('group-participants.update', refresh('group-participants.update'));
}

async function refreshGroupCache(tenantId) {
    ensureTenant(tenantId);
    const activeBots = Object.entries(operationBots[tenantId] || {});

    for (const [botId, sock] of activeBots) {
        await updateGroupCache(botId, sock, tenantId);
    }

    return getAllGroups(tenantId);
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

    if (await isAdminBotRecord(botId, tenantId)) {
        logger.warn(`[${botId}] is configured as admin bot; skipping operation bot connection.`);
        return null;
    }

    markRoutingExpected(tenantId, botId);

    if (reconnectTimers[timerKey] === 'connecting') {
        logger.warn(`[${botId}] Already connecting, skipping.`);
        return null;
    }

    const generation = operationSocketGenerations.next(tenantId, botId);

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${botId}] Max reconnect attempts reached.`);
        await updateBotStatus(botId, 'close', tenantId);
        clearRoutingExpected(tenantId, botId);
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
        registerGroupCacheRefreshHandlers(botId, sock, tenantId);

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (!operationSocketGenerations.isCurrent(tenantId, botId, generation)) return;

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
                    clearRoutingExpected(tenantId, botId);
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
        if (!operationSocketGenerations.isCurrent(tenantId, botId, generation)) {
            clearRoutingExpected(tenantId, botId);
            return null;
        }

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

    if (await isAdminBotRecord(botId, tenantId)) {
        logger.warn(`[${botId}] is configured as admin bot; skipping API operation bot connection.`);
        return null;
    }

    markRoutingExpected(tenantId, botId);
    const generation = operationSocketGenerations.next(tenantId, botId);
    let qrBase64 = null;

    try {
        const { sock } = await createSock(botId, tenantId);
        registerGroupCacheRefreshHandlers(botId, sock, tenantId);

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (!operationSocketGenerations.isCurrent(tenantId, botId, generation)) return;

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
                } else {
                    clearRoutingExpected(tenantId, botId);
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
        clearRoutingExpected(tenantId, botId);
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
        clearRoutingExpected(tenantId, botId);
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
    operationSocketGenerations.next(tenantId, botId);

    if (reconnectTimers[timerKey] && reconnectTimers[timerKey] !== 'connecting') {
        clearTimeout(reconnectTimers[timerKey]);
    }
    delete reconnectTimers[timerKey];
    if (groupRefreshTimers[timerKey]) {
        clearTimeout(groupRefreshTimers[timerKey]);
        delete groupRefreshTimers[timerKey];
    }

    // Disconnect socket
    if (operationBots[tenantId]?.[botId]) {
        try { await operationBots[tenantId][botId].end(); } catch (err) {}
        delete operationBots[tenantId][botId];
    }
    clearRoutingExpected(tenantId, botId);

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

    removeAuthSessionFiles(botId, tenantId);

    // Delete all bot records so offline ghosts do not stay visible in Bot Management.
    try {
        await deleteBotRecords(botId, tenantId);
        logger.info(`[${botId}] Deleted bot records + auth sessions (tenant ${tenantId})`);
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
    refreshGroupCache,
    updateGroupCache,
    updateBotStatus,
    registerGroupCacheRefreshHandlers,
    waitForRoutingReady,
    isRoutingReady,
    __markRoutingExpectedForTests: markRoutingExpected,
    __isAdminBotRecordForTests: isAdminBotRecord,
    __registerGroupCacheRefreshHandlersForTests: registerGroupCacheRefreshHandlers,
    __removeAuthSessionFilesForTests: removeAuthSessionFiles,
    __deleteBotRecordsForTests: deleteBotRecords,
    __resetRoutingReadinessForTests() {
        operationBots = {};
        groupBots = {};
        groupCache = {};
        routingReadyAt = {};
        routingWaiters.forEach(waiter => clearTimeout(waiter.timer));
        routingWaiters = [];
        routingExpectedBots = {};
        for (const key of Object.keys(reconnectTimers)) {
            if (reconnectTimers[key] && reconnectTimers[key] !== 'connecting') {
                clearTimeout(reconnectTimers[key]);
            }
            delete reconnectTimers[key];
        }
        for (const key of Object.keys(groupRefreshTimers)) {
            clearTimeout(groupRefreshTimers[key]);
            delete groupRefreshTimers[key];
        }
    }
};
