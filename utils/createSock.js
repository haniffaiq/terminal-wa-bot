// const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('baileys');
// const { globalAgent } = require('../bots/proxyConfig'); 
// const pino = require('pino');
// const fs = require('fs');
// const path = require('path');


// const STATUS_DIR = path.join(__dirname, '../data');
// const STATUS_FILE = path.join(STATUS_DIR, 'bot_status.json');
// function updateBotStatus(botId, status) {
//     if (!fs.existsSync(STATUS_DIR)) {
//         fs.mkdirSync(STATUS_DIR, { recursive: true });
//     }

//     if (!fs.existsSync(STATUS_FILE)) {
//         fs.writeFileSync(STATUS_FILE, JSON.stringify({}, null, 2));
//     }

//     let currentStatus = {};
//     try {
//         const content = fs.readFileSync(STATUS_FILE, 'utf-8');
//         currentStatus = JSON.parse(content || '{}');
//     } catch (err) {
//         console.error('Gagal membaca status file:', err);
//     }

//     currentStatus[botId] = status;

//     try {
//         fs.writeFileSync(STATUS_FILE, JSON.stringify(currentStatus, null, 2));
//     } catch (err) {
//         console.error('Gagal menulis status file:', err);
//     }
// }

// async function createSock(botId, options = {}) {
//     const AUTH_FOLDER = `./auth_sessions/${botId}`;
//     if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });


//     const pTerminal = botId === 'admin_bot' ? true : false;
//     const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
//     const logger = pino({ level: 'silent' });

//     const sock = makeWASocket({
//         auth: {
//             creds: state.creds,
//             keys: makeCacheableSignalKeyStore(state.keys, logger),
//         },
//         printQRInTerminal: pTerminal,
//         logger: pino({ level: 'silent' }),
//         agent: globalAgent
//         });

//     sock.logger.level = 'silent'; 

//     sock.ev.on('creds.update', saveCreds);

//     return { sock, saveCreds };
// }

// module.exports = { createSock, updateBotStatus };


const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const { globalAgent } = require('../bots/proxyConfig'); 
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

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
    
    console.log(`\n[DEBUG] Memulai createSock untuk: ${botId}`);
    console.log(`[DEBUG] Auth folder: ${AUTH_FOLDER}`);
    
    if (!fs.existsSync(AUTH_FOLDER)) {
        console.log(`[DEBUG] Membuat auth folder...`);
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    } else {
        const files = fs.readdirSync(AUTH_FOLDER);
        console.log(`[DEBUG] Auth folder sudah ada dengan ${files.length} files`);
        // JANGAN hapus session - biarkan Baileys yang handle
    }

    const showQRInTerminal = botId === 'admin_bot';
    console.log(`[DEBUG] showQRInTerminal: ${showQRInTerminal}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    console.log(`[DEBUG] State loaded`);
    
    // Fetch latest Baileys version
    let version;
    try {
        const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
        version = latestVersion;
        console.log(`[DEBUG] Baileys version: ${JSON.stringify(version)}, isLatest: ${isLatest}`);
    } catch (err) {
        console.log(`[DEBUG] Gagal fetch version, using default`);
    }
    
    const logger = pino({ level: 'silent' });

    const socketOptions = {
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger: logger,
        // browser: ['Ubuntu', 'Chrome', '1.0.0'],
        // connectTimeoutMs: 60000,
        // defaultQueryTimeoutMs: 60000,
        // keepAliveIntervalMs: 10000,
        // markOnlineOnConnect: false
    };

    if (version) {
        socketOptions.version = version;
    }

    if (globalAgent) {
        console.log(`[DEBUG] Menggunakan proxy agent`);
        // socketOptions.agent = globalAgent;
    } else {
        console.log(`[DEBUG] TIDAK menggunakan proxy`);
    }

    const sock = makeWASocket(socketOptions);

    console.log(`[DEBUG] Socket dibuat, registering event listeners...`);

    let qrAttempts = 0;

    // Event untuk menangani QR code
    sock.ev.on('connection.update', async (update) => {
        console.log(`\n[DEBUG] Connection update:`, JSON.stringify(update, null, 2));
        
        const { connection, lastDisconnect, qr } = update;

        // Tampilkan dan simpan QR code
        if (qr) {
            qrAttempts++;
            console.log(`[DEBUG] ✅ QR CODE DITERIMA! (Attempt ${qrAttempts})`);
            console.log(`[DEBUG] QR String length: ${qr.length}`);
            
            if (showQRInTerminal) {
                const qrFilePath = `./qr_${botId}.png`;
                
                try {
                    // Simpan QR code sebagai file PNG
                    await QRCode.toFile(qrFilePath, qr, {
                        width: 400,
                        margin: 2,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });
                    
                    console.log(`\n════════════════════════════════════`);
                    console.log(`✅ QR Code BERHASIL DISIMPAN!`);
                    console.log(`📁 Bot: ${botId}`);
                    console.log(`📁 File: ${qrFilePath}`);
                    console.log(`📁 Full path: ${path.resolve(qrFilePath)}`);
                    console.log(`⏰ Scan dalam 60 detik!`);
                    console.log(`════════════════════════════════════\n`);
                    
                    // Generate QR di terminal
                    const qrString = await QRCode.toString(qr, { 
                        type: 'terminal', 
                        small: true 
                    });
                    console.log(qrString);
                    
                } catch (err) {
                    console.error(`[${botId}] ❌ ERROR menyimpan QR code:`, err);
                }
            }
            
            updateBotStatus(botId, 'waiting_qr');
        }

        // Handle status koneksi
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.data?.reason;
            
            console.log(`[${botId}] ❌ Koneksi ditutup`);
            console.log(`[${botId}] Status code: ${statusCode}`);
            console.log(`[${botId}] Reason: ${reason}`);
            
            // Handle error 405
            if (statusCode === 405) {
                console.log(`[${botId}] 🔴 ERROR 405: Connection Failure`);
                console.log(`[${botId}] Kemungkinan masalah:`);
                console.log(`  - Proxy tidak mendukung WebSocket`);
                console.log(`  - Firewall memblokir koneksi`);
                console.log(`  - Versi Baileys perlu update`);
                updateBotStatus(botId, 'connection_error_405');
            } else if (statusCode === DisconnectReason.loggedOut) {
                updateBotStatus(botId, 'logged_out');
                console.log(`[${botId}] Device logged out. Hapus folder session manual dan restart.`);
            } else {
                updateBotStatus(botId, 'disconnected');
            }
            
            // JANGAN auto reconnect - biarkan caller yang handle
            console.log(`[${botId}] Socket ditutup. Tidak auto-reconnect.`);
            
        } else if (connection === 'connecting') {
            console.log(`[${botId}] 🔄 Menghubungkan...`);
            updateBotStatus(botId, 'connecting');
        } else if (connection === 'open') {
            console.log(`[${botId}] ✅ Koneksi berhasil terbuka!`);
            updateBotStatus(botId, 'connected');
            qrAttempts = 0;
            
            // Hapus QR file setelah berhasil connect
            const qrFilePath = `./qr_${botId}.png`;
            if (fs.existsSync(qrFilePath)) {
                fs.unlinkSync(qrFilePath);
                console.log(`[${botId}] QR Code file dihapus (sudah terkoneksi)`);
            }
        }
    });

    // Event untuk menyimpan kredensial
    sock.ev.on('creds.update', saveCreds);

    console.log(`[DEBUG] Event listeners registered\n`);

    return { sock, saveCreds };
}

module.exports = { createSock, updateBotStatus };