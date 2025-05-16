const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { globalAgent } = require('./proxyConfig');
const { createSock } = require('../utils/createSock');

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
}).child({ service: 'Operation' });

let operationBots = {};
let groupBots = {};

function getNextBotForGroup(groupId) {
    const activeBots = groupBots[groupId] || [];
    if (activeBots.length === 0) return null;

    // Cari bot yang aktif
    let nextBotId = null;

    // Loop untuk menemukan bot yang masih terhubung
    for (let i = 0; i < activeBots.length; i++) {
        const botId = activeBots[i];
        if (operationBots[botId]) { // Pastikan bot aktif
            nextBotId = botId;
            break;
        }
    }

    // Jika tidak ada bot aktif, kembalikan null
    if (!nextBotId) {
        logger.warn(`[${groupId}] Tidak ada bot aktif untuk group. Mengembalikan null.`);
        return null;
    }

    // Pindahkan bot yang dipilih ke belakang antrian untuk round-robin
    activeBots.shift(); // Hapus bot pertama yang dipilih
    activeBots.push(nextBotId); // Masukkan bot yang dipilih ke belakang
    groupBots[groupId] = activeBots; // Perbarui daftar bot di grup

    return operationBots[nextBotId];
}



async function getBotStatusList(target) {
    const sessionFolder = './auth_sessions/';

    if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder); // Kalau belum ada, buat folder
    }

    const botFolders = fs.readdirSync(sessionFolder).filter((bot) =>
        fs.statSync(path.join(sessionFolder, bot)).isDirectory() && bot !== 'admin_bot'
    );

    const connected = [];
    const disconnected = [];

    for (const botId of botFolders) {
        if (operationBots[botId]) {
            connected.push(botId);

            // ?? Langsung kirim message dari bot ini
            try {
                const bot = operationBots[botId];

                // Ganti dengan target jid kamu
                const targetJid = target;

                await bot.sendMessage(targetJid, { text: `Bot ${botId} sudah CONNECTED! ??` });
                logger.info(`[${botId}] Pesan berhasil dikirim ke ${target} `);
            } catch (err) {
                logger.error(`Gagal mengirim pesan dari bot ${botId}:`);
            }
        } else {
            disconnected.push(botId);
        }
    }

    return {
        connected,
        disconnected
    };
}

const reconnectAttempts = {}; // Pastikan mendeklarasikan di luar
const MAX_RECONNECT_ATTEMPTS = 5; // Tentukan jumlah maksimal reconnect
let isReconnecting = false; // Menyimpan status reconnecting secara global

async function reconnectSingleBot(botId) {
    const AUTH_FOLDER = `./auth_sessions/${botId}`;

    // Pastikan sesi bot ada
    if (!fs.existsSync(AUTH_FOLDER)) {
        logger.warn(`[${botId}] Tidak ada sesi untuk reconnect.`);
        return;
    }

    // Inisialisasi attempt reconnect untuk bot ini
    if (!reconnectAttempts[botId]) reconnectAttempts[botId] = 0;

    // Jika sudah mencapai batas maksimal reconnect, berhenti mencoba
    if (reconnectAttempts[botId] >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${botId}] Sudah ${MAX_RECONNECT_ATTEMPTS}x gagal reconnect. Stop mencoba.`);
        return;
    }

    // Hapus sock lama jika ada
    if (operationBots[botId]) {
        try {
            await operationBots[botId].end();
            logger.info(`[${botId}] Sock lama dihapus sebelum reconnect.`);
        } catch (e) {
            logger.warn(`[${botId}] Gagal end sock lama: ${e}`);
        }
        delete operationBots[botId];
    }

    // Coba reconnect bot
    try {
        logger.info(`[${botId}] Reconnecting attempt #${reconnectAttempts[botId] + 1}...`);

        const { sock, saveCreds } = await createSock(botId);


        operationBots[botId] = sock;

        sock.ev.on('creds.update', saveCreds);

        // Event listener untuk connection update
        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                logger.info(`[${botId}] Berhasil reconnect ke WhatsApp.`);
                
                reconnectAttempts[botId] = 0; // Reset reconnect counter
                return; 
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`[${botId}] Koneksi close, reason: ${statusCode}`);

                // Jika logged out, tidak coba reconnect
                if (statusCode === DisconnectReason.loggedOut  && reason === 'Unknown') {
                    logger.error(`[${botId}] Logged out, tidak akan reconnect.`);
                    delete reconnectAttempts[botId];
                    return;
                }

                // Proses reconnect jika belum mencapai max attempts
                reconnectAttempts[botId] += 1;
                if (reconnectAttempts[botId] >= MAX_RECONNECT_ATTEMPTS) {
                    logger.error(`[${botId}] Sudah gagal ${MAX_RECONNECT_ATTEMPTS}x. Tidak reconnect lagi.`);
                    return;
                }

                logger.info(`[${botId}] Akan reconnect attempt #${reconnectAttempts[botId]} dalam 5 detik...`);
                setTimeout(() => reconnectSingleBot(botId), 5000); // Menunggu sebelum mencoba reconnect lagi
            }
        });
    } catch (err) {
        logger.error(`[${botId}] Error saat reconnect: ${err}`);
        reconnectAttempts[botId] += 1;

        if (reconnectAttempts[botId] >= MAX_RECONNECT_ATTEMPTS) {
            logger.error(`[${botId}] Error reconnect. Sudah ${MAX_RECONNECT_ATTEMPTS}x gagal.`);
            return;
        }

        setTimeout(() => reconnectSingleBot(botId), 5000); // Menunggu sebelum mencoba reconnect lagi
    }
}

// Fungsi untuk melakukan reconnect ke semua bot
async function reconnectBot() {
    if (isReconnecting) {
        logger.info("Reconnect sedang berlangsung, tunggu sebentar...");
        return;
    }

    isReconnecting = true;
    const sessionFolder = './auth_sessions/';
    logger.info("Memulai reconnect untuk semua bot yang ada...");

    const botFolders = fs.readdirSync(sessionFolder);
    const validBotFolders = botFolders.filter((bot) => fs.statSync(path.join(sessionFolder, bot)).isDirectory());

    for (let botId of validBotFolders) {
        if (botId === 'admin_bot') {
            logger.warn(`Bot ${botId} dikecualikan dari proses reconnect.`);
            continue;
        }

        const AUTH_FOLDER = `${sessionFolder}${botId}`;

        // Pastikan bot memiliki sesi untuk reconnect
        if (!fs.existsSync(AUTH_FOLDER)) {
            logger.warn(`[${botId}] Tidak ada sesi untuk bot ini.`);
            continue;
        }

        logger.info(`Mencoba menghubungkan bot ${botId}...`);

        try {
            const { sock, saveCreds } = await createSock(botId);


            sock.ev.on('creds.update', saveCreds);

            // Event listener untuk connection update
            sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                if (connection === 'open') {
                    logger.info(`[${botId}] Berhasil terhubung kembali ke WhatsApp.`);
                    operationBots[botId] = sock;
                   
                    try {
                        const groupsArray = Object.values(await sock.groupFetchAllParticipating());
                        groupsArray.forEach((group) => {
                            if (!groupBots[group.id]) groupBots[group.id] = [];
                            if (!groupBots[group.id].includes(botId)) groupBots[group.id].push(botId);
                            // sock.sendMessage(group.id, { text: `Bot dengan ID ${botId} berhasil Reconnect.` });
                            logger.error(`Bot dengan ID ${botId} berhasil Reconnect`);

                        });
                        

                    } catch (err) {
                        logger.error(`[${botId}] Gagal mengambil grup: ${err}`);
                    }
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error ? lastDisconnect.error.output.statusCode : 'Unknown';
                    logger.warn(`[${botId}] Koneksi terputus. Alasan: ${reason}`);
                    if (reason !== DisconnectReason.loggedOut && reason === 'Unknown') {
                        logger.warn(reason);
                        logger.info(`[${botId}] Mencoba menyambung kembali dalam 5 detik.`);
                        setTimeout(() => reconnectSingleBot(botId), 5000);
                        
                    }
                }
            });

        } catch (error) {
            logger.error(`[${botId}] Gagal menghubungkan kembali bot: ${error}`);
        }
    }

    isReconnecting = false;
}


async function startOperationBot(botId, adminSock, chatId) {
    const AUTH_FOLDER = `./auth_sessions/${botId}`;

    logger.info(`[${botId}] Memulai bot operation.`);

    try {
        // if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        const { sock, saveCreds } = await createSock(botId);

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                logger.info(`[${botId}] QR Code diterima, menyimpan.`);

                const qrPath = `./auth_sessions/${botId}.png`;
                if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

                await qrcode.toFile(qrPath, qr);
                const imageBuffer = fs.readFileSync(qrPath);
                await adminSock.sendMessage(chatId, { image: imageBuffer, caption: "Scan QR Code ini untuk menambahkan bot baru." });
                logger.info(`[${botId}] QR Code bot baru dikirim.`);
            }

            if (connection === 'open') {
                logger.info(`[${botId}] Berhasil terhubung ke WhatsApp.`);
                await adminSock.sendMessage(chatId, { text: `Bot dengan ID ${botId} berhasil masuk.` });

                operationBots[botId] = sock;

                try {
                    const groupsArray = Object.values(await sock.groupFetchAllParticipating());
                    groupsArray.forEach((group) => {
                        if (!groupBots[group.id]) groupBots[group.id] = [];
                        if (!groupBots[group.id].includes(botId)) groupBots[group.id].push(botId);
                    });

                } catch (err) {
                    logger.error(`[${botId}] Gagal mengambil grup: ${err}`);
                }

            }
            if (connection === 'close') {
                const reason = lastDisconnect?.error ? lastDisconnect.error.output.statusCode : 'Unknown';
                logger.warn(`[${botId}] Koneksi terputus. Alasan: ${reason}`);

                if (reason === DisconnectReason.loggedOut && reason === 'Unknown') {
                    logger.info(`[${botId}] Sesi dihapus, menunggu scan ulang.`);
                    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    delete operationBots[botId];
                    groupBots[chatId] = groupBots[chatId].filter(bot => bot !== botId);
                } else {
                    logger.info(`[${botId}] Mencoba menyambung kembali dalam 5 detik.`);
                    setTimeout(() => startOperationBot(botId, adminSock, chatId), 5000);
                }
            }
        });

        return sock;
    } catch (error) {
        logger.error(`[${botId}] Gagal memulai bot operation: ${error}`);
    }
}

async function startOperationBotAPI(botId) {
    const AUTH_FOLDER = `./auth_sessions/${botId}`;

    logger.info(`[${botId}] Memulai bot operation.`);

    let qrBase64 = null; // <-- untuk menyimpan QR base64

    try {
        // if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        const { sock, saveCreds } = await createSock(botId);

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                logger.info(`[${botId}] QR Code diterima, menyimpan ke file.`);

                const qrPath = `./auth_sessions/${botId}.png`;
                if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

                await qrcode.toFile(qrPath, qr); // Save QR ke file

                const imageBuffer = fs.readFileSync(qrPath); // Baca file QR
                qrBase64 = `data:image/png;base64,${imageBuffer.toString('base64')}`; // Ubah ke base64 dengan prefix

                logger.info(`[${botId}] QR Code base64 siap.`);
            }

            if (connection === 'open') {
                logger.info(`[${botId}] Berhasil terhubung ke WhatsApp.`);

                operationBots[botId] = sock;

                const groupsArray = Object.values(await sock.groupFetchAllParticipating());
                groupsArray.forEach((group) => {
                    if (!groupBots[group.id]) groupBots[group.id] = [];
                    if (!groupBots[group.id].includes(botId)) groupBots[group.id].push(botId);
                });

                const groupsArray2 = ["120363416299189686@g.us", "120363400049027196@g.us", "120363398957841140@g.us"];
                groupsArray2.forEach((group) => {
                    if (!groupBots[group.id]) groupBots[group.id] = [];
                    if (!groupBots[group.id].includes(botId)) groupBots[group.id].push(botId);
                });
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error ? lastDisconnect.error.output.statusCode : 'Unknown';
                logger.warn(`[${botId}] Koneksi terputus. Alasan: ${reason}`);

                if (reason === DisconnectReason.loggedOut && reason === 'Unknown') {
                    logger.info(`[${botId}] Sesi dihapus, menunggu scan ulang.`);
                    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    delete operationBots[botId];
                } else {
                    logger.info(`[${botId}] Mencoba menyambung kembali dalam 5 detik.`);
                    setTimeout(() => startOperationBotAPI(botId), 5000);
                }
            }
        });

        return new Promise((resolve) => {
            const checkQR = setInterval(() => {
                if (qrBase64) {
                    clearInterval(checkQR);
                    resolve(qrBase64);
                }
            }, 500);

            setTimeout(() => {
                clearInterval(checkQR);
                resolve(null); // timeout 15 detik
            }, 15000);
        });

    } catch (error) {
        logger.error(`[${botId}] Gagal memulai bot operation: ${error}`);
        return null;
    }
}


function getOperationSock(botId) {
    // return operationBots[botId] || null;
    return groupBots || null;
}

async function stopOperationBot(botId) {
    const AUTH_FOLDER = `./auth_sessions/${botId}`;

    if (fs.existsSync(AUTH_FOLDER)) {
        await fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        logger.info(`[${botId}] Bot dihapus.`);
    } else {
        logger.warn(`[${botId}] Tidak ditemukan session.`);
    }

    if (operationBots[botId]) {
        logger.info(`[${botId}] Menghentikan bot.`);
        await operationBots[botId].end();
        await delete operationBots[botId];
    }
    return true;
}

module.exports = {
    startOperationBot,
    getOperationSock,
    stopOperationBot,
    reconnectBot,
    getNextBotForGroup,
    startOperationBotAPI,
    getBotStatusList
};
