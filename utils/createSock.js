const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('baileys');
const { globalAgent } = require('../bots/proxyConfig'); // atau agent proxy kamu
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

    currentStatus[botId] = status;

    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(currentStatus, null, 2));
    } catch (err) {
        console.error('Gagal menulis status file:', err);
    }
}

async function createSock(botId, options = {}) {
    const AUTH_FOLDER = `./auth_sessions/${botId}`;
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });


    const pTerminal = botId === 'admin_bot' ? true : false;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: pTerminal,
        logger: pino({ level: 'silent' }),
        //agent: globalAgent
        });
    
    sock.logger.level = 'silent'; 

    sock.ev.on('creds.update', saveCreds);

    return { sock, saveCreds };
}

module.exports = { createSock, updateBotStatus };
