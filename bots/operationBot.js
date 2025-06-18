const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { globalAgent } = require('./proxyConfig');
const { createSock, updateBotStatus } = require('../utils/createSock');



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

// function getNextBotForGroup(groupId) {
//     const activeBots = groupBots[groupId] || [];
//     if (activeBots.length === 0) return null;

//     // Cari bot yang aktif
//     let nextBotId = null;

//     // Loop untuk menemukan bot yang masih terhubung
//     for (let i = 0; i < activeBots.length; i++) {
//         const botId = activeBots[i];
//         if (operationBots[botId]) { // Pastikan bot aktif
//             nextBotId = botId;
//             break;
//         }
//     }

//     // Jika tidak ada bot aktif, kembalikan null
//     if (!nextBotId) {
//         logger.warn(`[${groupId}] Tidak ada bot aktif untuk group. Mengembalikan null.`);
//         return null;
//     }

//     // Pindahkan bot yang dipilih ke belakang antrian untuk round-robin
//     activeBots.shift(); // Hapus bot pertama yang dipilih
//     activeBots.push(nextBotId); // Masukkan bot yang dipilih ke belakang
//     groupBots[groupId] = activeBots; // Perbarui daftar bot di grup

//     return operationBots[nextBotId];
// }


async function disconnectBotForce(botId) {
    if (!operationBots[botId]) {
        logger.warn(`[${botId}] Bot tidak ditemukan atau belum terhubung.`);
        return { success: false, message: 'Bot tidak aktif' };
    }

    try {
        logger.info(`[${botId}] Memutuskan koneksi secara paksa (tanpa logout).`);
        // await operationBots[botId].ws.close();  // Menutup koneksi WebSocket secara paksa
        await operationBots[botId].end();  // Menutup koneksi WebSocket secara paksa

        updateBotStatus(botId, "close")
        return { success: true, message: 'Koneksi diputus secara paksa' };
    } catch (err) {
        logger.error(`[${botId}] Gagal memutus koneksi: ${err}`);
        return { success: false, message: 'Gagal disconnect', error: err.toString() };
    }
}


const STATUS_FILE = path.join(__dirname, '../data/bot_status.json');

function getBotStatusMap() {
    if (!fs.existsSync(STATUS_FILE)) return {};
    try {
        const data = fs.readFileSync(STATUS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Gagal membaca bot_status.json:', err);
        return {};
    }
}

function getNextBotForGroup(groupId) {
    const activeBots = groupBots[groupId] || [];
    if (activeBots.length === 0) return null;

    const statusMap = getBotStatusMap();

    const filteredBots = activeBots.filter(botId =>
        statusMap[botId] === 'open' && operationBots[botId]
    );

    if (filteredBots.length === 0) {
        logger.warn(`[${groupId}] Tidak ada bot dengan status 'open' untuk group.`);
        return null;
    }

    const nextBotId = filteredBots[0];

    // Round robin: putar posisi bot di daftar groupBots[groupId]
    const index = activeBots.indexOf(nextBotId);
    if (index !== -1) {
        activeBots.splice(index, 1);      // Hapus dari posisi sekarang
        activeBots.push(nextBotId);       // Tambahkan ke belakang
    }

    groupBots[groupId] = activeBots;

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
                updateBotStatus(botId, "open")
                reconnectAttempts[botId] = 0; // Reset reconnect counter
                return;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`[${botId}] Koneksi close, reason: ${statusCode}`);
                updateBotStatus(botId, "close")
                // Jika logged out, tidak coba reconnect
                const reason = lastDisconnect?.error ? lastDisconnect.error.output.statusCode : 'Unknown';
                
                if (statusCode !== DisconnectReason.loggedOut && reason === 'Unknown') {
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


async function reconnectSingleBotCommand(botId, chatId) {
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
                updateBotStatus(botId, "open")
                await sock.sendMessage(chatId, { text: `Bot *${botId}* Telah Connect!` });
                await sock.sendMessage(chatId, { text: `!hi` });

                reconnectAttempts[botId] = 0; // Reset reconnect counter
                return;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`[${botId}] Koneksi close, reason: ${statusCode}`);
                updateBotStatus(botId, "close")
                // Jika logged out, tidak coba reconnect
                const reason = lastDisconnect?.error ? lastDisconnect.error.output.statusCode : 'Unknown';
                
                if (statusCode !== DisconnectReason.loggedOut && reason === 'Unknown') {
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

async function reconnectSingleBotAPI(botId) {
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
                updateBotStatus(botId, "open")
                reconnectAttempts[botId] = 0; // Reset reconnect counter
                return;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`[${botId}] Koneksi close, reason: ${statusCode}`);
                updateBotStatus(botId, "close")
                // Jika logged out, tidak coba reconnect
                const reason = lastDisconnect?.error ? lastDisconnect.error.output.statusCode : 'Unknown';
                
                if (statusCode !== DisconnectReason.loggedOut && reason === 'Unknown') {
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


                        });

                        logger.info(`Bot dengan ID ${botId} berhasil Reconnect`);
                        updateBotStatus(botId, "open")


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
                        updateBotStatus(botId, "close")
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


// async function startOperationBot(botId, adminSock, chatId) {
//     const AUTH_FOLDER = `./auth_sessions/${botId}`;

//     logger.info(`[${botId}] Memulai bot operation.`);

//     try {
//         // if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
//         const { sock, saveCreds } = await createSock(botId);

//         sock.ev.on('creds.update', saveCreds);
//         sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
//             if (qr) {
//                 logger.info(`[${botId}] QR Code diterima, menyimpan.`);

//                 const qrPath = `./auth_sessions/${botId}.png`;
//                 if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

//                 await qrcode.toFile(qrPath, qr);
//                 const imageBuffer = fs.readFileSync(qrPath);
//                 await adminSock.sendMessage(chatId, { image: imageBuffer, caption: "Scan QR Code ini untuk menambahkan bot baru." });
//                 logger.info(`[${botId}] QR Code bot baru dikirim.`);
//             }

//             if (connection === 'open') {
//                 logger.info(`[${botId}] Berhasil terhubung ke WhatsApp.`);
//                 await adminSock.sendMessage(chatId, { text: `Bot dengan ID ${botId} berhasil masuk.` });
//                 updateBotStatus(botId, "open")
//                 operationBots[botId] = sock;

//                 try {
//                     const groupsArray = Object.values(await sock.groupFetchAllParticipating());
//                     groupsArray.forEach((group) => {
//                         if (!groupBots[group.id]) groupBots[group.id] = [];
//                         if (!groupBots[group.id].includes(botId)) groupBots[group.id].push(botId);
//                     });

//                 } catch (err) {
//                     logger.error(`[${botId}] Gagal mengambil grup: ${err}`);
//                 }

//             }
//             if (connection === 'close') {
//                 const reason = lastDisconnect?.error ? lastDisconnect.error.output.statusCode : 'Unknown';
//                 logger.warn(`[${botId}] Koneksi terputus. Alasan: ${reason}`);
//                 updateBotStatus(botId, "close")

//                 if (reason === DisconnectReason.loggedOut && reason === 'Unknown') {
//                     logger.info(`[${botId}] Sesi dihapus, menunggu scan ulang.`);
//                     fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
//                     delete operationBots[botId];
//                     groupBots[chatId] = groupBots[chatId].filter(bot => bot !== botId);
//                 } else {
//                     logger.info(`[${botId}] Mencoba menyambung kembali dalam 5 detik.`);
//                     setTimeout(() => startOperationBot(botId, adminSock, chatId), 5000);
//                 }
//             }
//         });

//         return sock;
//     } catch (error) {
//         logger.error(`[${botId}] Gagal memulai bot operation: ${error}`);
//     }
// }

const isConnecting = {};

async function startOperationBot(botId, adminSock, chatId) {
    const AUTH_FOLDER = `./auth_sessions/${botId}`;
    logger.info(`[${botId}] Memulai bot operation.`);

    if (isConnecting[botId]) {
        logger.warn(`[${botId}] Bot sedang dalam proses koneksi. Melewati duplikasi.`);
        return;
    }
    isConnecting[botId] = true;

    try {
        const { sock, saveCreds } = await createSock(botId);

        sock.ev.on('creds.update', saveCreds);

        let qrSent = false;
        let connected = false;

        sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (qr && !qrSent) {
                const statusMap = getBotStatusMap();
                if (statusMap[botId] !== 'open') {
                    logger.info(`[${botId}] QR Code diterima, menyimpan.`);

                    const qrPath = `./auth_sessions/${botId}.png`;
                    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

                    await qrcode.toFile(qrPath, qr);
                    const imageBuffer = fs.readFileSync(qrPath);
                    await adminSock.sendMessage(chatId, { image: imageBuffer, caption: "Scan QR Code ini untuk menambahkan bot baru." });
                    logger.info(`[${botId}] QR Code bot baru dikirim.`);
                }
                qrSent = true;
            }

            if (connection === 'open' && !connected) {
                logger.info(`[${botId}] Berhasil terhubung ke WhatsApp.`);
                await adminSock.sendMessage(chatId, { text: `Bot dengan ID ${botId} berhasil masuk.` });
                updateBotStatus(botId, "open");
                operationBots[botId] = sock;
                connected = true;

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
                const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn(`[${botId}] Koneksi terputus. Alasan: ${reason}`);
                updateBotStatus(botId, "close");
                isConnecting[botId] = false;

                if (reason === DisconnectReason.loggedOut || reason === 'Unknown') {
                    logger.info(`[${botId}] Sesi dihapus, menunggu scan ulang.`);
                    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    delete operationBots[botId];
                    if (groupBots[chatId]) {
                        groupBots[chatId] = groupBots[chatId].filter(bot => bot !== botId);
                    }
                } else {
                    logger.info(`[${botId}] Mencoba menyambung kembali dalam 5 detik.`);
                    setTimeout(() => startOperationBot(botId, adminSock, chatId), 5000);
                }
            }
        });

        return sock;
    } catch (error) {
        logger.error(`[${botId}] Gagal memulai bot operation: ${error}`);
    } finally {
        // Clear connecting flag hanya jika tidak ada loop reconnect
        setTimeout(() => {
            isConnecting[botId] = false;
        }, 10000); // clear flag dalam 10 detik untuk jaga-jaga
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

    // Hapus folder session jika ada
    if (fs.existsSync(AUTH_FOLDER)) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        logger.info(`[${botId}] Folder session dihapus.`);
    } else {
        logger.warn(`[${botId}] Folder session tidak ditemukan.`);
    }

    // Hentikan bot jika masih aktif di operationBots
    if (operationBots[botId]) {
        logger.info(`[${botId}] Menghentikan bot.`);
        try {
            await operationBots[botId].end();
        } catch (err) {
            logger.error(`[${botId}] Gagal menghentikan bot: ${err}`);
        }
        delete operationBots[botId];
    } else {
        logger.warn(`[${botId}] Bot tidak ditemukan di operationBots.`);
    }

    // Update bot_status.json
    const STATUS_FILE = path.join(__dirname, '../data/bot_status.json');
    if (fs.existsSync(STATUS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
            delete data[botId];
            fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
            logger.info(`[${botId}] Dihapus dari bot_status.json.`);
        } catch (err) {
            logger.error(`Gagal update bot_status.json: ${err}`);
        }
    }

    return true;
}

// Map untuk menyimpan antrian round-robin per nomor individual
const individualBots = {};  // contoh: { '628123xxx@c.us': ['bot1', 'bot2', ...] }

function getNextBotForIndividual(number) {
    const statusMap = getBotStatusMap();

    // Jika belum ada daftar bot untuk nomor ini, inisialisasi dengan semua bot operasi yang 'open'
    if (!individualBots[number]) {
        individualBots[number] = Object.keys(operationBots).filter(
            botId => statusMap[botId] === 'open'
        );
    }

    const activeBots = individualBots[number];

    if (!activeBots || activeBots.length === 0) {
        logger.warn(`[${number}] Tidak ada bot aktif untuk individual`);
        return null;
    }

    const botId = activeBots[0];

    // Round robin: pindahkan bot ke akhir daftar
    activeBots.push(activeBots.shift());

    // Simpan kembali urutan terbaru
    individualBots[number] = activeBots;

    return operationBots[botId];
}


module.exports = {
    startOperationBot,
    getOperationSock,
    stopOperationBot,
    reconnectBot,
    getNextBotForGroup,
    startOperationBotAPI,
    getBotStatusList,
    reconnectSingleBot,
    reconnectSingleBotCommand,
    reconnectSingleBotAPI,
    disconnectBotForce,
    getNextBotForIndividual
};
