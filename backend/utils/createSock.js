const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const STATUS_DIR = path.join(__dirname, '../data');
const STATUS_FILE = path.join(STATUS_DIR, 'bot_status.json');

function updateBotStatus(botId, status) {
    if (!fs.existsSync(STATUS_DIR)) {
        fs.mkdirSync(STATUS_DIR, { recursive: true });
    }

    if (!fs.existsSync(STATUS_FILE)) {
        fs.writeFileSync(STATUS_FILE, JSON.stringify({}, null, 2));
    }

    let currentStatus = {};
    try {
        const content = fs.readFileSync(STATUS_FILE, 'utf-8');
        currentStatus = JSON.parse(content || '{}');
    } catch (err) {
        console.error('Gagal membaca status file:', err);
    }

    // Don't write if status hasn't changed
    if (currentStatus[botId] === status) return;

    currentStatus[botId] = status;

    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(currentStatus, null, 2));
    } catch (err) {
        console.error('Gagal menulis status file:', err);
    }

    // Emit to dashboard only for final states (open/close)
    if (status === 'open' || status === 'close') {
        try {
            const { io } = require('../index');
            if (io) {
                io.emit('bot:status', { botId, status, timestamp: new Date().toISOString() });
            }
        } catch (e) {
            // io not ready yet during startup, ignore
        }
    }
}

async function createSock(botId) {
    const AUTH_FOLDER = path.join(__dirname, '..', 'auth_sessions', botId);

    if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    // Fetch latest Baileys version
    let version;
    try {
        const { version: latestVersion } = await fetchLatestBaileysVersion();
        version = latestVersion;
    } catch (err) {
        console.log(`[${botId}] Gagal fetch version, using default`);
    }

    const logger = pino({ level: 'silent' });

    const socketOptions = {
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: false,
        retryRequestDelayMs: 2000,
    };

    if (version) {
        socketOptions.version = version;
    }

    const sock = makeWASocket(socketOptions);

    // Only handle creds.update here — connection lifecycle is the caller's job
    sock.ev.on('creds.update', saveCreds);

    return { sock, saveCreds };
}

module.exports = { createSock, updateBotStatus };
