const { makeWASocket, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, proto, initAuthCreds } = require('baileys');
const pino = require('pino');
const { query } = require('./db');

// DB-backed auth state (replaces useMultiFileAuthState)
async function useDatabaseAuthState(botId, tenantId) {
    const tId = tenantId || '__global__';

    async function readData(key) {
        try {
            const result = await query(
                'SELECT key_data FROM auth_sessions WHERE tenant_id = $1 AND bot_id = $2 AND key_name = $3',
                [tId, botId, key]
            );
            if (result.rows.length === 0) return null;
            return result.rows[0].key_data;
        } catch (err) {
            return null;
        }
    }

    async function writeData(key, data) {
        try {
            await query(
                `INSERT INTO auth_sessions (tenant_id, bot_id, key_name, key_data, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (tenant_id, bot_id, key_name)
                 DO UPDATE SET key_data = $4, updated_at = NOW()`,
                [tId, botId, key, JSON.stringify(data)]
            );
        } catch (err) {
            console.error(`Auth state write error [${botId}]:`, err.message);
        }
    }

    async function removeData(key) {
        try {
            await query(
                'DELETE FROM auth_sessions WHERE tenant_id = $1 AND bot_id = $2 AND key_name = $3',
                [tId, botId, key]
            );
        } catch (err) {}
    }

    // Load or init credentials
    const credsData = await readData('creds');
    const creds = credsData ? JSON.parse(typeof credsData === 'string' ? credsData : JSON.stringify(credsData)) : initAuthCreds();

    const saveCreds = async () => {
        await writeData('creds', creds);
    };

    const keys = {
        get: async (type, ids) => {
            const result = {};
            for (const id of ids) {
                const data = await readData(`${type}-${id}`);
                if (data) {
                    let parsed = typeof data === 'string' ? JSON.parse(data) : data;
                    // Handle Buffer fields for proto types
                    if (type === 'app-state-sync-key') {
                        result[id] = proto.Message.AppStateSyncKeyData.fromObject(parsed);
                    } else {
                        result[id] = parsed;
                    }
                }
            }
            return result;
        },
        set: async (data) => {
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    if (value) {
                        await writeData(`${category}-${id}`, value);
                    } else {
                        await removeData(`${category}-${id}`);
                    }
                }
            }
        }
    };

    return { state: { creds, keys }, saveCreds };
}

async function createSock(botId, tenantId) {
    const { state, saveCreds } = await useDatabaseAuthState(botId, tenantId);

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
