const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

async function createSock(botId, tenantId) {
    // Tenant-scoped auth folder
    const AUTH_FOLDER = tenantId
        ? path.join(__dirname, '..', 'auth_sessions', tenantId, botId)
        : path.join(__dirname, '..', 'auth_sessions', botId);

    if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    // Use Baileys native file-based auth (reliable, handles Buffer serialization correctly)
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    let version;
    try {
        const { version: latestVersion } = await fetchLatestBaileysVersion();
        version = latestVersion;
    } catch (err) {
        console.log(`[${botId}] Failed to fetch version, using default`);
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
    sock.ev.on('creds.update', saveCreds);

    return { sock, saveCreds };
}

module.exports = { createSock };
