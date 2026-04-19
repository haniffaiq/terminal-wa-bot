const { makeWASocket, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, proto, initAuthCreds, BufferJSON } = require('baileys');
const pino = require('pino');
const { query } = require('./db');

/**
 * DB-backed auth state — exact mirror of Baileys useMultiFileAuthState
 * but writes to PostgreSQL instead of filesystem.
 *
 * key_data column is TEXT — stores raw JSON.stringify output with BufferJSON.replacer
 * so PostgreSQL never touches the content (no JSONB parsing).
 */
async function useDatabaseAuthState(botId, tenantId) {
    const tid = tenantId || '__global__';

    async function writeData(data, key) {
        const json = JSON.stringify(data, BufferJSON.replacer);
        try {
            await query(
                `INSERT INTO auth_sessions (tenant_id, bot_id, key_name, key_data, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (tenant_id, bot_id, key_name)
                 DO UPDATE SET key_data = $4, updated_at = NOW()`,
                [tid, botId, key, json]
            );
        } catch (err) {
            console.error(`[${botId}] auth write error (${key}):`, err.message);
        }
    }

    async function readData(key) {
        try {
            const result = await query(
                'SELECT key_data FROM auth_sessions WHERE tenant_id = $1 AND bot_id = $2 AND key_name = $3',
                [tid, botId, key]
            );
            if (result.rows.length === 0) return null;
            return JSON.parse(result.rows[0].key_data, BufferJSON.reviver);
        } catch (err) {
            return null;
        }
    }

    async function removeData(key) {
        try {
            await query(
                'DELETE FROM auth_sessions WHERE tenant_id = $1 AND bot_id = $2 AND key_name = $3',
                [tid, botId, key]
            );
        } catch (err) {}
    }

    // Load creds or init fresh (same as Baileys)
    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
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
