const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { startOperationBot, stopOperationBot, reconnectBot, getOperationSock, getBotStatusList, reconnectSingleBotCommand, updateGroupCache } = require('./operationBot');

const { createSock, updateBotStatus } = require('../utils/createSock');
const { connected, disconnect } = require('process');
const http = require("http");
const https = require("https");


const STATUS_FILE = path.join(__dirname, '../data/bot_status.json');

let adminGlobalSock = null
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
}).child({ service: 'ADMIN' });

const BLOCK_FILE = './blocked.json';

function readBlockedList() {
    try {
        if (!fs.existsSync(BLOCK_FILE)) return [];
        const data = fs.readFileSync(BLOCK_FILE, 'utf8');
        return JSON.parse(data || '[]');
    } catch (err) {
        logger.error("Error reading block list:", err);
        return [];
    }
}

function saveBlockedList(list) {
    try {
        fs.writeFileSync(BLOCK_FILE, JSON.stringify(list, null, 2));
    } catch (err) {
        logger.error("Error saving block list:", err);
    }
}
const BOT_ID = 'admin_bot';
const AUTH_FOLDER = `./auth_sessions/${BOT_ID}`;
const QR_IMAGE_PATH = './auth_sessions/admin_bot.png';

let reconnectTimeout;

async function startAdminBot() {
    await reconnectBot();
    logger.info('Starting admin bot...');
    try {

        const { sock, saveCreds } = await createSock(BOT_ID);
        adminGlobalSock = sock

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                try {
                    if (fs.existsSync(QR_IMAGE_PATH)) {
                        fs.unlinkSync(QR_IMAGE_PATH);
                        logger.info('Old QR code removed.');
                    }
                    qrcodeTerminal.generate(qr, { small: true });
                    await qrcode.toFile(QR_IMAGE_PATH, qr);
                    logger.info(`QR Code saved to ${QR_IMAGE_PATH}`);
                } catch (err) {
                    logger.error({ err }, 'Failed to process QR code.');
                }
            }

            if (connection === 'open') {
                logger.info('Connected to WhatsApp!');
                updateBotStatus(BOT_ID, "open")
                await updateGroupCache(BOT_ID, sock);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`Connection closed. Reason: ${reason}`);

                if (reason !== DisconnectReason.loggedOut) {
                    logger.info('Reconnecting in 5 seconds...');
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = setTimeout(startAdminBot, 5000);
                    updateBotStatus(BOT_ID, "close")

                } else {
                    logger.error('Bot logged out. QR scan required.');
                    updateBotStatus(BOT_ID, "close")
                }
            }
        });

        sock.ev.on('error', (err) => {
            logger.error({ err }, 'Connection error occurred.');
        });

        setupAdminCommands(sock);
        logger.info('Waiting for WhatsApp connection...');
        return sock;
    } catch (error) {
        logger.error({ error }, 'Failed to start bot.');
        logger.info('Retrying in 10 seconds...');
        setTimeout(startAdminBot, 10000);
    }
}

async function sendQRToGroup(sock, groupId) {
    try {
        if (!fs.existsSync(QR_IMAGE_PATH)) {
            logger.warn('QR not generated yet, cannot send.');
            return;
        }

        const imageBuffer = fs.readFileSync(QR_IMAGE_PATH);
        await sock.sendMessage(groupId, {
            image: imageBuffer,
            caption: "Scan QR Code ini untuk menambahkan bot."
        });

        logger.info(`QR sent to group ${groupId}`);
    } catch (err) {
        logger.error({ err }, 'Failed to send QR to group.');
    }
}

async function getGroupInfo(sock, groupId) {
    try {
        const metadata = await sock.groupMetadata(groupId);

        const groupName = metadata.subject || 'No name';
        const groupId_ = metadata.id;
        const memberCount = metadata.participants.length;
        const adminList = metadata.participants
            .filter(p => p.admin)
            .map(p => p.id.split('@')[0]);

        const description = metadata.desc || 'No description.';
        const createdAt = new Date(metadata.creation * 1000).toLocaleString('id-ID');
        const createdBy = metadata.creator ? metadata.creator.split('@')[0] : 'Unknown';
        const restrictInfo = metadata.restrict ? 'Admin Only' : 'All Members';
        const announceInfo = metadata.announce ? 'Admin Only' : 'All Members';

        let message = `*ZYRON Group Info*\n\n`;
        message += `*Group Name:* ${groupName}\n`;
        message += `*Group ID:* ${groupId_}\n`;
        message += `*Members:* ${memberCount}\n`;
        message += `*Admins:*\n${adminList.map(a => `- ${a}`).join('\n')}\n`;
        message += `*Description:* ${description}\n`;
        message += `*Created:* ${createdAt}\n`;
        message += `*Created by:* ${createdBy}\n`;
        message += `*Edit Info:* ${restrictInfo}\n`;
        message += `*Send Messages:* ${announceInfo}`;

        return message;

    } catch (err) {
        console.error(`Failed to get group info: ${err}`);
        return `Failed to get group info. Make sure the bot is in the group.`;
    }
}

async function callApi(keyword, type) {
    return new Promise((resolve, reject) => {
        const baseUrl = "http://10.17.7.147:9098/autohealing/api/network_intelligent_api.php";
        const params = new URLSearchParams({ keyword, type }).toString();
        const url = `${baseUrl}?${params}`;

        http.get(url, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    resolve({ raw: data });
                }
            });
        }).on("error", (err) => reject(err));
    });
}



function callBotApiPMTCMT(params) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            param1: params.param1 || "-",
            param2: params.param2 || "-",
            param3: params.param3 || "-",
            param4: params.param4 || "-",
            param5: params.param5 || "-",
            param6: params.param6 || "-"
        });

        // Proxy info
        const proxyHost = "10.17.6.215";
        const proxyPort = 8080;
        const proxyUser = "WAserver";
        const proxyPass = "Bandar12#$";

        // Target API info
        const targetHost = "10.17.7.14";
        const targetPort = 8088;
        const targetPath = "/v1/bot";

        const options = {
            host: proxyHost,
            port: proxyPort,
            method: 'POST',
            path: `http://${targetHost}:${targetPort}${targetPath}`,
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
                "Authorization": "Basic " + Buffer.from("whatsapp_bot1:wabot123").toString("base64"),
                "Proxy-Authorization": "Basic " + Buffer.from(`${proxyUser}:${proxyPass}`).toString("base64")
            }
        };

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    resolve({ raw: data });
                }
            });
        });

        req.on("error", (err) => reject(err));
        req.write(postData);
        req.end();
    });
}


function setupAdminCommands(sock) {
    logger.info('Ready to receive commands.');
    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message?.message || !message.key.remoteJid) return;

        const chatId = message.key.remoteJid;
        const text = message.message.conversation || message.message.extendedTextMessage?.text;

        if (!text) return;

        if (text.startsWith('!addbot')) {
            const [, botName] = text.split(' ');
            if (!botName) {
                return sock.sendMessage(chatId, { text: '*Usage:* !addbot <bot_name>' });
            }

            logger.info(`Adding bot: ${botName}`);
            startOperationBot(botName, sock, chatId);
            sock.sendMessage(chatId, { text: `*ZYRON* Bot *${botName}* is being added. QR code incoming...` });
        }

        if (text.startsWith('!rst')) {
            const [, botName] = text.split(' ');
            if (!botName) {
                return sock.sendMessage(chatId, { text: '*Usage:* !rst <bot_name>' });
            }

            logger.info(`Restarting bot: ${botName}`);
            reconnectSingleBotCommand(botName, chatId);
            sock.sendMessage(chatId, { text: `*ZYRON* Bot *${botName}* is restarting...` });
        }

        if (text.startsWith('!rmbot')) {
            const [, botNumber] = text.split(' ');
            if (!botNumber) {
                return sock.sendMessage(chatId, { text: '*Usage:* !rmbot <bot_name>' });
            }

            await stopOperationBot(botNumber);
            sock.sendMessage(chatId, { text: `*ZYRON* Bot *${botNumber}* has been removed.` });
            logger.info(`Bot ${botNumber} removed.`);
        }

        if (text.startsWith('!cmd')) {
            const parts = text.trim().split(' ');
            if (parts.length < 3) {
                return sock.sendMessage(chatId, {
                    text: '*Usage:* !cmd <type> <keyword>'
                });
            }

            const cmdType = parts[1];
            const keyword = parts.slice(2).join(' ');

            try {
                const data = await callApi(keyword, cmdType);

                if (data?.result === "OK") {
                    await sock.sendMessage(chatId, {
                        text: "Menunggu Respons Autohealing"
                    });
                } else {
                    await sock.sendMessage(chatId, {
                        text: "Gagal atau respons tidak sesuai"
                    });
                }

                logger.info("CMD executed", data);

            } catch (err) {
                console.error("ERROR in !cmd handler:", err?.stack || err);

                try {
                    await sock.sendMessage(chatId, {
                        text: "Gagal memproses perintah. Cek log untuk detail."
                    });
                } catch (_) { }
            }
        }

        if (text.startsWith('!block')) {
            const [, groupId] = text.split(' ');

            if (!groupId) {
                return sock.sendMessage(chatId, {
                    text: '*Usage:* !block <group_id>'
                });
            }

            let blockedList = readBlockedList();

            if (blockedList.includes(groupId)) {
                return sock.sendMessage(chatId, {
                    text: `*ZYRON* Group already blocked: ${groupId}`
                });
            }

            blockedList.push(groupId);
            saveBlockedList(blockedList);

            logger.info(`Group blocked: ${groupId}`);

            sock.sendMessage(chatId, {
                text: `*ZYRON* Group blocked: ${groupId}`
            });
        }

        if (text.startsWith('!open')) {
            const [, groupId] = text.split(' ');

            if (!groupId) {
                return sock.sendMessage(chatId, {
                    text: '*Usage:* !open <group_id>'
                });
            }

            let blockedList = readBlockedList();

            if (!blockedList.includes(groupId)) {
                return sock.sendMessage(chatId, {
                    text: `*ZYRON* Group not in block list: ${groupId}`
                });
            }

            blockedList = blockedList.filter(id => id !== groupId);
            saveBlockedList(blockedList);

            logger.info(`Group unblocked: ${groupId}`);

            sock.sendMessage(chatId, {
                text: `*ZYRON* Group unblocked: ${groupId}`
            });
        }

        if (text === '!listblock') {
            const blockedList = readBlockedList();

            if (blockedList.length === 0) {
                return sock.sendMessage(chatId, {
                    text: "*ZYRON* No groups are blocked."
                });
            }

            sock.sendMessage(chatId, {
                text: "*ZYRON Blocked Groups:*\n" + blockedList.join('\n')
            });
        }



        if (text.startsWith("!pmtcmt")) {
            const parts = text.trim().split(/\s+/);

            const param1 = parts[1] || "-";
            const param2 = parts[2] || "-";
            const param3 = parts[3] || "-";
            const param4 = parts[4] || "-";
            const param5 = parts[5] || "-";
            const param6 = parts[6] || "-";


            try {
                const apiResp = await callBotApiPMTCMT({ param1, param2, param3, param4, param5 });
                logger.info("PMTCMT API response:", apiResp);

                const respMessage = apiResp && (apiResp.message || JSON.stringify(apiResp, null, 2));

                if (apiResp && (apiResp.success === true || apiResp.code === 200)) {
                    await sock.sendMessage(chatId, {
                        text: `PMT CMT API berhasil dipanggil\nResponse:\n${respMessage}`
                    });
                } else {
                    const body = apiResp && (apiResp.raw ? apiResp.raw : JSON.stringify(apiResp, null, 2));
                    await sock.sendMessage(chatId, {
                        text: `PMT CMT API gagal.\nResponse:\n${body || "No response"}`
                    });
                }

            } catch (err) {
                logger.error("Error !pmtcmt:", err);
                await sock.sendMessage(chatId, { text: "Error panggil PMT CMT API. Cek log." });
            }
        }




        if (text.startsWith('!botstatus')) {
            let status = await checkBotStatus();
            sock.sendMessage(chatId, { text: status });
        }

        if (text.startsWith('!restart')) {
            await reconnectBot();
            sock.sendMessage(chatId, { text: `*ZYRON* Restarting all operation bots...` });
            logger.info(`Restarting all operation bots.`);
        }

        if (text === '!groupid') {
            sock.sendMessage(chatId, { text: `*ZYRON* Group ID: ${chatId}` });
            logger.info(`Group ID requested by ${chatId}`);
        }

        if (text === '!hi') {
            try {
                logger.info('Check Connection All Bot');
                data = getOperationSock()

                await testConnection(chatId)
                await getBotStatusList(chatId);

            } catch (err) {
                logger.error({ err }, 'Failed to get operation bot info.');
            }
        }
        if (text.startsWith('!ho')) {
            try {
                const [command] = text.split(' ');
                if (command === '!ho') {
                    logger.info('Check Connection All Bot');

                    const data = getOperationSock();

                    await testConnection(chatId);
                    await getBotStatusList(chatId);

                }
            } catch (err) {
                logger.error({ err }, 'Failed to get operation bot info.');
            }
        }
        if (text === '!info') {
            try {
                let groupInfo = await getGroupInfo(sock, chatId)
                logger.info(groupInfo);
                sock.sendMessage(chatId, { text: `${groupInfo}` });
            } catch (err) {
                logger.error({ err }, 'Failed to get group info.');
            }
        }
    });
}


function checkBotStatus() {
    let status = ""
    let message = `*ZYRON Bot Status*\n`;

    if (!fs.existsSync(STATUS_FILE)) {
        console.log('[Heartbeat] No status file found.');
        return;
    }

    try {
        const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
        const statusData = JSON.parse(raw || '{}');

        const connectedBot = [];
        const disconnectedBot = [];

        for (const [botId, status] of Object.entries(statusData)) {
            if (status === 'open') {
                connectedBot.push(botId);
            } else {
                disconnectedBot.push(botId);
            }
        }


        if (connectedBot.length > 0) {
            message += `\n*Online (${connectedBot.length}):*\n${connectedBot.join('\n')}`;
        } else {
            message += `\n*No bots connected.*`;
        }

        if (disconnectedBot.length > 0) {
            message += `\n\n*Offline (${disconnectedBot.length}):*\n${disconnectedBot.join('\n')}`;
        }


    } catch (err) {
        message = '[Heartbeat] Failed to read status file:', err;
    }
    return message
}

function statusBotAPI() {
    let status = ""
    let message = `*ZYRON Bot Status*\n`;

    if (!fs.existsSync(STATUS_FILE)) {
        console.log('[Heartbeat] No status file found.');
        return;
    }

    const connectedBot = [];
    const disconnectedBot = [];
    try {
        const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
        const statusData = JSON.parse(raw || '{}');


        for (const [botId, status] of Object.entries(statusData)) {
            if (status === 'open') {
                connectedBot.push(botId);
            } else {
                disconnectedBot.push(botId);
            }
        }


        if (connectedBot.length > 0) {
            message += `\n*Online (${connectedBot.length}):*\n${connectedBot.join('\n')}`;
        } else {
            message += `\n*No bots connected.*`;
        }

        if (disconnectedBot.length > 0) {
            message += `\n\n*Offline (${disconnectedBot.length}):*\n${disconnectedBot.join('\n')}`;
        }


    } catch (err) {
        message = '[Heartbeat] Failed to read status file:', err;
    }
    return { "active": connectedBot, "inactive": disconnectedBot }
}



function testConnection(target) {
    adminGlobalSock.sendMessage(target, { text: `[PLATFORM]--Bot ADMIN sudah CONNECTED!` });
}

module.exports = { startAdminBot, testConnection, checkBotStatus, statusBotAPI };
