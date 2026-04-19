const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const { DisconnectReason } = require('baileys');
const { createSock, updateBotStatus } = require('../utils/createSock');

// --- Logger setup ---
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            levelFirst: true
        }
    },
    level: 'info'
}).child({ service: 'Operation' });

let operationBots = {};
let groupBots = {};
const reconnectTimers = {};
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 10000;

const STATUS_FILE = path.join(__dirname, '../data/bot_status.json');

function getBotStatusMap() {
    if (!fs.existsSync(STATUS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    } catch (err) {
        return {};
    }
}

// ============================================================
// Core: single connect function used by ALL paths
// ============================================================
async function connectBot(botId, opts = {}) {
    const { adminSock, chatId, attempt = 0 } = opts;

    if (reconnectTimers[botId] === 'connecting') {
        logger.warn(`[${botId}] Already connecting, skipping.`);
        return null;
    }

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${botId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
        updateBotStatus(botId, 'close');
        return null;
    }

    // Clean up old socket
    if (operationBots[botId]) {
        try { await operationBots[botId].end(); } catch (e) {}
        delete operationBots[botId];
    }

    // Clear pending reconnect timer
    if (reconnectTimers[botId] && reconnectTimers[botId] !== 'connecting') {
        clearTimeout(reconnectTimers[botId]);
        delete reconnectTimers[botId];
    }

    reconnectTimers[botId] = 'connecting';

    try {
        logger.info(`[${botId}] Connecting (attempt ${attempt + 1})...`);
        const { sock } = await createSock(botId);

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr && adminSock && chatId) {
                try {
                    const qrPath = path.join(__dirname, '..', 'auth_sessions', `${botId}.png`);
                    await qrcode.toFile(qrPath, qr);
                    const imageBuffer = fs.readFileSync(qrPath);
                    await adminSock.sendMessage(chatId, {
                        image: imageBuffer,
                        caption: `Scan QR Code untuk bot ${botId}`
                    });
                } catch (err) {
                    logger.error(`[${botId}] Gagal kirim QR: ${err.message}`);
                }
            }

            if (connection === 'open') {
                logger.info(`[${botId}] Connected.`);
                operationBots[botId] = sock;
                updateBotStatus(botId, 'open');
                delete reconnectTimers[botId];

                if (adminSock && chatId) {
                    try {
                        await adminSock.sendMessage(chatId, { text: `Bot ${botId} berhasil connect.` });
                    } catch (e) {}
                }

                try {
                    const groups = Object.values(await sock.groupFetchAllParticipating());
                    groups.forEach((group) => {
                        if (!groupBots[group.id]) groupBots[group.id] = [];
                        if (!groupBots[group.id].includes(botId)) groupBots[group.id].push(botId);
                    });
                    logger.info(`[${botId}] Registered in ${groups.length} groups.`);
                } catch (err) {
                    logger.error(`[${botId}] Gagal fetch groups: ${err.message}`);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                logger.warn(`[${botId}] Disconnected (reason: ${statusCode}).`);
                updateBotStatus(botId, 'close');
                delete operationBots[botId];
                delete reconnectTimers[botId];

                if (statusCode === DisconnectReason.loggedOut) {
                    logger.error(`[${botId}] Logged out. Session cleared.`);
                    const authFolder = path.join(__dirname, '..', 'auth_sessions', botId);
                    if (fs.existsSync(authFolder)) {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                    }
                    for (const gId of Object.keys(groupBots)) {
                        groupBots[gId] = groupBots[gId].filter(b => b !== botId);
                    }
                } else {
                    const delay = RECONNECT_DELAY * (attempt + 1);
                    logger.info(`[${botId}] Will reconnect in ${delay / 1000}s...`);
                    reconnectTimers[botId] = setTimeout(() => {
                        connectBot(botId, { adminSock, chatId, attempt: attempt + 1 });
                    }, delay);
                }
            }
        });

        return sock;
    } catch (err) {
        logger.error(`[${botId}] Connect error: ${err.message}`);
        delete reconnectTimers[botId];

        const delay = RECONNECT_DELAY * (attempt + 1);
        reconnectTimers[botId] = setTimeout(() => {
            connectBot(botId, { adminSock, chatId, attempt: attempt + 1 });
        }, delay);
        return null;
    }
}

// ============================================================
// Public API — all delegate to connectBot
// ============================================================

async function startOperationBot(botId, adminSock, chatId) {
    return connectBot(botId, { adminSock, chatId });
}

async function reconnectSingleBot(botId) {
    return connectBot(botId);
}

async function reconnectSingleBotCommand(botId) {
    return connectBot(botId);
}

async function reconnectSingleBotAPI(botId) {
    return connectBot(botId);
}

async function startOperationBotAPI(botId) {
    let qrBase64 = null;

    try {
        const { sock } = await createSock(botId);

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                try {
                    const qrPath = path.join(__dirname, '..', 'auth_sessions', `${botId}.png`);
                    await qrcode.toFile(qrPath, qr);
                    const imageBuffer = fs.readFileSync(qrPath);
                    qrBase64 = `data:image/png;base64,${imageBuffer.toString('base64')}`;
                } catch (err) {
                    logger.error(`[${botId}] QR error: ${err.message}`);
                }
            }

            if (connection === 'open') {
                logger.info(`[${botId}] Connected via API.`);
                operationBots[botId] = sock;
                updateBotStatus(botId, 'open');

                try {
                    const groups = Object.values(await sock.groupFetchAllParticipating());
                    groups.forEach((group) => {
                        if (!groupBots[group.id]) groupBots[group.id] = [];
                        if (!groupBots[group.id].includes(botId)) groupBots[group.id].push(botId);
                    });
                } catch (err) {
                    logger.error(`[${botId}] Gagal fetch groups: ${err.message}`);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                updateBotStatus(botId, 'close');

                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(() => connectBot(botId), RECONNECT_DELAY);
                }
            }
        });

        return new Promise((resolve) => {
            const checkQR = setInterval(() => {
                if (qrBase64) {
                    clearInterval(checkQR);
                    resolve(qrBase64);
                }
            }, 500);

            setTimeout(() => {
                clearInterval(checkQR);
                resolve(null);
            }, 15000);
        });
    } catch (error) {
        logger.error(`[${botId}] API start error: ${error.message}`);
        return null;
    }
}

// Reconnect all existing bots on startup
let isReconnecting = false;

async function reconnectBot() {
    if (isReconnecting) return;
    isReconnecting = true;

    const sessionFolder = path.join(__dirname, '..', 'auth_sessions');
    if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
        isReconnecting = false;
        return;
    }

    const botFolders = fs.readdirSync(sessionFolder).filter((bot) => {
        const fullPath = path.join(sessionFolder, bot);
        return fs.statSync(fullPath).isDirectory() && bot !== 'admin_bot';
    });

    logger.info(`Reconnecting ${botFolders.length} operation bots...`);

    for (const botId of botFolders) {
        await connectBot(botId);
        await new Promise(r => setTimeout(r, 3000));
    }

    isReconnecting = false;
    logger.info('All operation bots reconnect initiated.');
}

// ============================================================
// Bot selection & management
// ============================================================

function getNextBotForGroup(groupId) {
    const activeBots = groupBots[groupId] || [];
    if (activeBots.length === 0) return null;

    const statusMap = getBotStatusMap();
    const filteredBots = activeBots.filter(botId =>
        statusMap[botId] === 'open' && operationBots[botId]
    );
    if (filteredBots.length === 0) return null;

    const nextBotId = filteredBots[0];
    const index = activeBots.indexOf(nextBotId);
    if (index !== -1) {
        activeBots.splice(index, 1);
        activeBots.push(nextBotId);
    }
    groupBots[groupId] = activeBots;
    return operationBots[nextBotId];
}

function getNextBotForIndividual(number) {
    const statusMap = getBotStatusMap();
    const activeBotIds = Object.keys(operationBots).filter(
        botId => statusMap[botId] === 'open'
    );
    if (activeBotIds.length === 0) return null;
    return operationBots[activeBotIds[0]];
}

async function disconnectBotForce(botId) {
    if (!operationBots[botId]) {
        return { success: false, message: 'Bot tidak aktif' };
    }

    if (reconnectTimers[botId] && reconnectTimers[botId] !== 'connecting') {
        clearTimeout(reconnectTimers[botId]);
        delete reconnectTimers[botId];
    }

    try {
        await operationBots[botId].end();
        delete operationBots[botId];
        updateBotStatus(botId, 'close');
        return { success: true, message: 'Koneksi diputus' };
    } catch (err) {
        return { success: false, message: 'Gagal disconnect', error: err.toString() };
    }
}

async function getBotStatusList(target) {
    const sessionFolder = path.join(__dirname, '..', 'auth_sessions');
    if (!fs.existsSync(sessionFolder)) return { connected: [], disconnected: [] };

    const botFolders = fs.readdirSync(sessionFolder).filter((bot) =>
        fs.statSync(path.join(sessionFolder, bot)).isDirectory() && bot !== 'admin_bot'
    );

    const connected = [];
    const disconnected = [];

    for (const botId of botFolders) {
        if (operationBots[botId]) {
            connected.push(botId);
            if (target) {
                try {
                    await operationBots[botId].sendMessage(target, { text: `Bot ${botId} CONNECTED` });
                } catch (err) {}
            }
        } else {
            disconnected.push(botId);
        }
    }
    return { connected, disconnected };
}

function getOperationSock() {
    return groupBots || null;
}

async function stopOperationBot(botId) {
    if (reconnectTimers[botId] && reconnectTimers[botId] !== 'connecting') {
        clearTimeout(reconnectTimers[botId]);
        delete reconnectTimers[botId];
    }

    const AUTH_FOLDER = path.join(__dirname, '..', 'auth_sessions', botId);
    if (fs.existsSync(AUTH_FOLDER)) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }

    if (operationBots[botId]) {
        try { await operationBots[botId].end(); } catch (err) {}
        delete operationBots[botId];
    }

    for (const gId of Object.keys(groupBots)) {
        groupBots[gId] = groupBots[gId].filter(b => b !== botId);
    }

    if (fs.existsSync(STATUS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
            delete data[botId];
            fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
        } catch (err) {}
    }

    return true;
}

module.exports = {
    startOperationBot,
    getOperationSock,
    stopOperationBot,
    reconnectBot,
    getNextBotForGroup,
    startOperationBotAPI,
    getBotStatusList,
    reconnectSingleBot,
    reconnectSingleBotCommand,
    reconnectSingleBotAPI,
    disconnectBotForce,
    getNextBotForIndividual
};
