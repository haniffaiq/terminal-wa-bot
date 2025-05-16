const { makeWASocket, useMultiFileAuthState } = require('baileys');
const { globalAgent } = require('../bots/proxyConfig'); // atau agent proxy kamu
const pino = require('pino');
const fs = require('fs');

async function createSock(botId, options = {}) {
    const AUTH_FOLDER = `./auth_sessions/${botId}`;
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });


    const pTerminal = botId === 'admin_bot' ? true : false;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: pTerminal,
        logger: pino({ level: 'silent' }),
        //agent: globalAgent
        });
    
    sock.logger.level = 'silent'; 

    sock.ev.on('creds.update', saveCreds);

    return { sock, saveCreds };
}

module.exports = { createSock };
