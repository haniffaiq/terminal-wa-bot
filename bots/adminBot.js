const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { startOperationBot, stopOperationBot, reconnectBot, getOperationSock, getBotStatusList, reconnectSingleBotCommand } = require('./operationBot');
const { globalAgent } = require('./proxyConfig');
const { createSock, updateBotStatus } = require('../utils/createSock');
const { connected, disconnect } = require('process');


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
}).child({ service: 'ADMIN' }); // <<<<< setiap log akan ada [service: AdminBot]


const BOT_ID = 'admin_bot';
const AUTH_FOLDER = `./auth_sessions/${BOT_ID}`;
const QR_IMAGE_PATH = './auth_sessions/admin_bot.png';

let reconnectTimeout;

async function startAdminBot() {
    await reconnectBot();
    logger.info('Memulai bot admin...');
    try {

        const { sock, saveCreds } = await createSock(BOT_ID);
        adminGlobalSock = sock

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                try {
                    if (fs.existsSync(QR_IMAGE_PATH)) {
                        fs.unlinkSync(QR_IMAGE_PATH);
                        logger.info('QR code lama dihapus.');
                    }
                    qrcodeTerminal.generate(qr, { small: true });
                    await qrcode.toFile(QR_IMAGE_PATH, qr);
                    logger.info(`QR Code disimpan di ${QR_IMAGE_PATH}`);
                } catch (err) {
                    logger.error({ err }, 'Gagal memproses QR code.');
                }
            }

            if (connection === 'open') {
                logger.info('Terhubung ke WhatsApp!');
                updateBotStatus(BOT_ID, "open")

            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`Koneksi terputus. Alasan: ${reason}`);

                if (reason !== DisconnectReason.loggedOut) {
                    logger.info('Reconnecting dalam 5 detik...');
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = setTimeout(startAdminBot, 5000);
                    updateBotStatus(BOT_ID, "close")

                } else {
                    logger.error('Bot logout. Scan ulang diperlukan.');
                    updateBotStatus(BOT_ID, "close")
                }
            }
        });

        sock.ev.on('error', (err) => {
            logger.error({ err }, 'Terjadi error di koneksi.');
        });

        setupAdminCommands(sock);
        logger.info('Menunggu koneksi ke WhatsApp...');
        return sock;
    } catch (error) {
        logger.error({ error }, 'Gagal memulai bot.');
        logger.info('Mencoba ulang dalam 10 detik...');
        setTimeout(startAdminBot, 10000);
    }
}

async function sendQRToGroup(sock, groupId) {
    try {
        if (!fs.existsSync(QR_IMAGE_PATH)) {
            logger.warn('QR belum dibuat, tidak bisa dikirim.');
            return;
        }

        const imageBuffer = fs.readFileSync(QR_IMAGE_PATH);
        await sock.sendMessage(groupId, {
            image: imageBuffer,
            caption: "Scan QR Code ini untuk menambahkan bot."
        });

        logger.info(`QR berhasil dikirim ke grup ${groupId}`);
    } catch (err) {
        logger.error({ err }, 'Gagal mengirim QR ke grup.');
    }
}

async function getGroupInfo(sock, groupId) {
    try {
        const metadata = await sock.groupMetadata(groupId);

        const groupName = metadata.subject || 'Tidak ada nama';
        const groupId_ = metadata.id;
        const memberCount = metadata.participants.length;
        const adminList = metadata.participants
            .filter(p => p.admin)
            .map(p => p.id.split('@')[0]); // Ambil nomor saja

        const description = metadata.desc || 'Tidak ada deskripsi.';
        const createdAt = new Date(metadata.creation * 1000).toLocaleString('id-ID');
        const createdBy = metadata.creator ? metadata.creator.split('@')[0] : 'Unknown';
        const restrictInfo = metadata.restrict ? 'Hanya Admin' : 'Semua Member';
        const announceInfo = metadata.announce ? 'Hanya Admin' : 'Semua Member';

        let message = `*Informasi Grup*\n\n`;
        message += `*Nama Grup:* ${groupName}\n`;
        message += `*ID Grup:* ${groupId_}\n`;
        message += `*Jumlah Anggota:* ${memberCount}\n`;
        message += `*Admin Grup:*\n${adminList.map(a => `- ${a}`).join('\n')}\n`;
        message += `*Deskripsi:* ${description}\n`;
        message += `*Dibuat pada:* ${createdAt}\n`;
        message += `*Dibuat oleh:* ${createdBy}\n`;
        message += `*Edit Info:* ${restrictInfo}\n`;
        message += `*Kirim Pesan:* ${announceInfo}`;

        return message;

    } catch (err) {
        console.error(`Gagal mengambil info grup: ${err}`);
        return `?? Gagal mengambil info grup. Pastikan bot ada di grup.`;
    }
}


function setupAdminCommands(sock) {
    logger.info('Siap menerima pesan command.');
    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message?.message || !message.key.remoteJid) return;

        const chatId = message.key.remoteJid;
        const text = message.message.conversation || message.message.extendedTextMessage?.text;

        if (!text) return;

        if (text.startsWith('!addbot')) {
            const [, botName] = text.split(' ');
            if (!botName) {
                return sock.sendMessage(chatId, { text: 'Gunakan format: *!addbot <nama_bot>*' });
            }

            logger.info(`Menambahkan bot: ${botName}`);
            startOperationBot(botName, sock, chatId);
            sock.sendMessage(chatId, { text: `Bot *${botName}* berhasil ditambahkan!` });
        }

        if (text.startsWith('!rst')) {
            const [, botName] = text.split(' ');
            if (!botName) {
                return sock.sendMessage(chatId, { text: 'Gunakan format: *!rst <nama_bot>*' });
            }

            logger.info(`Menambahkan bot: ${botName}`);
            reconnectSingleBotCommand(botName, chatId);
            sock.sendMessage(chatId, { text: `Bot *${botName}* Sedang direstart!` });
        }

        if (text.startsWith('!rmbot')) {
            const [, botNumber] = text.split(' ');
            if (!botNumber) {
                return sock.sendMessage(chatId, { text: 'Gunakan format: *!rmbot <nomor>*' });
            }

            await stopOperationBot(botNumber);
            sock.sendMessage(chatId, { text: `Bot ${botNumber} dihapus.` });
            logger.info(`Bot ${botNumber} dihapus.`);
        }

        if (text.startsWith('!botstatus')) {
            let status = await checkBotStatus();
            sock.sendMessage(chatId, { text: status });
        }

        if (text.startsWith('!restart')) {
            await reconnectBot();
            sock.sendMessage(chatId, { text: `Merestart Semua Bot Operation.` });
            logger.info(`Merestart Semua Bot Operation.`);
        }

        if (text === '!groupid') {
            sock.sendMessage(chatId, { text: `*Group ID:* ${chatId}` });
            logger.info(`Group ID diminta oleh ${chatId}`);
        }

        if (text === '!hi') {
            try {
                logger.info('Check Connection All Bot');
                data = getOperationSock()
                // logger.info(data);

                await testConnection(chatId)
                await getBotStatusList(chatId);

                // sock.sendMessage(chatId, { text: `*Data* ${data}` });
            } catch (err) {
                logger.error({ err }, 'Gagal Info Operation Bot.');
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

                    // Kirim data jika perlu
                    // await sock.sendMessage(chatId, { text: `*Data:* ${JSON.stringify(data)}` });
                }
            } catch (err) {
                logger.error({ err }, 'Gagal Info Operation Bot.');
            }
        }
        if (text === '!info') {
            try {
                let groupInfo = await getGroupInfo(sock, chatId)
                logger.info(groupInfo);
                sock.sendMessage(chatId, { text: `*Data* ${groupInfo}` });
            } catch (err) {
                logger.error({ err }, 'Gagal Info Operation Bot.');
            }
        }
    });
}


function checkBotStatus() {
    let status = ""
    let message = `?? *Status Bot:*\n`;

    if (!fs.existsSync(STATUS_FILE)) {
        console.log('[Heartbeat] Tidak ada file status.');
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
            message += `\n*Terhubung (${connectedBot.length}):*\n${connectedBot.join('\n')}`;
        } else {
            message += `\n*Tidak ada bot yang terhubung.*`;
        }

        if (disconnectedBot.length > 0) {
            message += `\n\n*Tidak Terhubung (${disconnectedBot.length}):*\n${disconnectedBot.join('\n')}`;
        }


    } catch (err) {
        message = '[Heartbeat] Gagal membaca status file:', err;
    }
    return message
}
// ======================== DEVELOPMEN FEATURE ============================

function statusBotAPI() {
    let status = ""
    let message = `?? *Status Bot:*\n`;

    if (!fs.existsSync(STATUS_FILE)) {
        console.log('[Heartbeat] Tidak ada file status.');
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
            message += `\n*Terhubung (${connectedBot.length}):*\n${connectedBot.join('\n')}`;
        } else {
            message += `\n*Tidak ada bot yang terhubung.*`;
        }

        if (disconnectedBot.length > 0) {
            message += `\n\n*Tidak Terhubung (${disconnectedBot.length}):*\n${disconnectedBot.join('\n')}`;
        }


    } catch (err) {
        message = '[Heartbeat] Gagal membaca status file:', err;
    }
    return { "active": connectedBot, "inactive": disconnectedBot}
}



function testConnection(target) {
    adminGlobalSock.sendMessage(target, { text: `Bot ADMIN sudah CONNECTED!` });
}

module.exports = { startAdminBot, testConnection, checkBotStatus, statusBotAPI };
