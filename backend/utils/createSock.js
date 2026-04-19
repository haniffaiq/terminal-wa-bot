const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

async function createSock(botId, tenantId) {
    const AUTH_FOLDER = tenantId
        ? path.join(__dirname, '..', 'auth_sessions', tenantId, botId)
        : path.join(__dirname, '..', 'auth_sessions', botId);

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

module.exports = { createSock };
