const { makeWASocket, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, proto, initAuthCreds, BufferJSON } = require('baileys');
const pino = require('pino');
const { query } = require('./db');

// Serialize with Buffer support (same as Baileys useMultiFileAuthState)
function serialize(data) {
    return JSON.stringify(data, BufferJSON.replacer);
}

function deserialize(str) {
    return JSON.parse(str, BufferJSON.reviver);
}

// DB-backed auth state
async function useDatabaseAuthState(botId, tenantId) {
    const tId = tenantId || '__global__';

    async function readData(key) {
        try {
            const result = await query(
                'SELECT key_data FROM auth_sessions WHERE tenant_id = $1 AND bot_id = $2 AND key_name = $3',
                [tId, botId, key]
            );
            if (result.rows.length === 0) return null;
            const raw = result.rows[0].key_data;
            // key_data is stored as text (serialized JSON with Buffer support)
            if (typeof raw === 'string') return deserialize(raw);
            // If PostgreSQL returned it as parsed JSON, re-serialize then deserialize for Buffer revival
            return deserialize(JSON.stringify(raw));
        } catch (err) {
            return null;
        }
    }

    async function writeData(key, data) {
        try {
            const serialized = serialize(data);
            await query(
                `INSERT INTO auth_sessions (tenant_id, bot_id, key_name, key_data, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (tenant_id, bot_id, key_name)
                 DO UPDATE SET key_data = $4, updated_at = NOW()`,
                [tId, botId, key, serialized]
            );
        } catch (err) {
            console.error(`Auth write error [${botId}/${key}]:`, err.message);
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
    const creds = credsData || initAuthCreds();

    const saveCreds = async () => {
        await writeData('creds', creds);
    };

    const keys = {
        get: async (type, ids) => {
            const result = {};
            for (const id of ids) {
                const data = await readData(`${type}-${id}`);
                if (data) {
                    if (type === 'app-state-sync-key') {
                        result[id] = proto.Message.AppStateSyncKeyData.fromObject(data);
                    } else {
                        result[id] = data;
                    }
                }
            }
            return result;
        },
        set: async (data) => {
            const promises = [];
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    if (value) {
                        promises.push(writeData(`${category}-${id}`, value));
                    } else {
                        promises.push(removeData(`${category}-${id}`));
                    }
                }
            }
            await Promise.all(promises);
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
