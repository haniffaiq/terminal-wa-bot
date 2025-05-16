
const express = require('express');
const { startAdminBot, testConnection } = require('./bots/adminBot');
const { getOperationSock, getNextBotForGroup, reconnectBot, startOperationBotAPI, getBotStatusList } = require('./bots/operationBot');
const midleware = require('./utils/midleware');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const mime = require('mime-types');

process.on('uncaughtException', (err) => {
    console.error('? Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('? Unhandled Rejection at:', promise, 'reason:', reason);
});
const app = express();
app.use(express.urlencoded({ extended: true }));

app.use(express.json());
app.use(midleware);

// Helper function untuk format waktu
function formatDate(date) {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    const milliseconds = String(d.getMilliseconds()).padStart(3, '0');

    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}:${milliseconds}`;
}


// Jalankan Admin Bot
startAdminBot();


let todayDate = getTodayDate();
let requestCounter = 0;

function getTodayDate() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${year}${month}${day}`;
}

function getCurrentTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${hours}${minutes}${seconds}`;
}

function generateTransactionId(code) {
    const todayDate = getTodayDate();
    const currentTime = getCurrentTime();
    const epochTime = Math.floor(Date.now() / 1000); // Detik, bukan milidetik

    return `${code}-${todayDate}-${currentTime}-${epochTime}`;
}

// Lokasi file log berdasarkan level
const logDir = './logs'; // Sesuaikan dengan direktori log yang Anda inginkan
// const infoLogFile = path.join(logDir, 'info.log');
// const errorLogFile = path.join(logDir, 'error.log');
// const warnLogFile = path.join(logDir, 'warn.log');

// Penamaan file log berdasarkan level
const infoLogFile = path.join(logDir, `success-wa-history-${todayDate}.log`);
const errorLogFile = path.join(logDir, `error-wa-${todayDate}.log`);
const warnLogFile = path.join(logDir, `warn-wa-history-${todayDate}.log`);


// Pastikan direktori log ada
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Logger function
function logger(type, message, ...optionalParams) {
    const timestamp = formatDate(new Date());

    // Format log message
    const logMessage = `[${timestamp}] [${type.toUpperCase()}]: ${message}`;

    // Menulis log ke konsol
    switch (type) {
        case 'info':
            console.log(logMessage, ...optionalParams);
            writeLogToFile(infoLogFile, logMessage);
            break;
        case 'error':
            console.error(logMessage, ...optionalParams);
            writeLogToFile(errorLogFile, logMessage);
            break;
        case 'warn':
            console.warn(logMessage, ...optionalParams);
            writeLogToFile(warnLogFile, logMessage);
            break;
        default:
            console.log(logMessage, ...optionalParams);
            break;
    }
}

// Fungsi untuk menulis log ke file
function writeLogToFile(filePath, logMessage) {
    fs.appendFile(filePath, logMessage + '\n', (err) => {
        if (err) {
            console.error(`Gagal menulis ke file: ${filePath}`, err);
        }
    });
}


// Fungsi untuk menyimpan request body ke file
// Fungsi untuk menyimpan request yang gagal
function saveFailedRequest(data, transactionId) {
    const failedRequestsFile = path.join(__dirname, 'failed_requests.json');

    // Membaca file jika sudah ada
    fs.readFile(failedRequestsFile, (err, fileData) => {
        let failedRequests = [];
        if (!err && fileData.length > 0) {
            failedRequests = JSON.parse(fileData);  // Ambil data sebelumnya
        }

        // Tambahkan transactionId ke dalam data
        const failedData = {
            ...data,
            transactionId, // <--- Inject transactionId ke object
            saved_at: new Date().toISOString() // (Optional) Tambahkan waktu disimpan
        };

        // Menambahkan request baru ke array
        failedRequests.push(failedData);

        // Simpan kembali ke file
        fs.writeFile(failedRequestsFile, JSON.stringify(failedRequests, null, 2), (err) => {
            if (err) {
                console.error('Gagal menyimpan request gagal:', err);
            } else {
                console.log('Request gagal berhasil disimpan.');
            }
        });
    });
}

// Fungsi untuk mengirim ulang request (misalnya melalui API)
// Fungsi untuk mengirim pesan ulang
async function resendFailedRequest(reqBody, transactionId) {
    let { number, message } = reqBody;

    if (!number || !message) {
        logger('error', `[${transactionId}] Parameter 'number' dan 'message' diperlukan`);
        return { success: false, error: 'Parameter number dan message diperlukan!' };
    }

    // Kalau number bukan array, ubah jadi array supaya aman
    if (!Array.isArray(number)) {
        number = [number];
    }

    if (number.length > 10) {
        logger('error', `[${transactionId}] Max number adalah 10 Receipent`);
        return { success: false, error: 'Max number adalah 10 Receipent' };
    }

    const results = [];

    for (const groupId of number) {
        logger('info', `[${transactionId}] Mencari bot aktif untuk grup: ${groupId}`);
        const botSock = getNextBotForGroup(groupId); // Asumsikan fungsi ini tersedia

        if (!botSock || !botSock.sendMessage) {
            logger('warn', `[${transactionId}] Tidak ada bot operasi yang aktif di grup ${groupId}`);
            results.push({ number: groupId, success: false, error: `Tidak ada bot aktif di grup ${groupId}`, response_time_seconds: 0 });
            continue;
        }

        const sendStartTime = Date.now(); // Start stopwatch per message

        try {
            // Deteksi jika message berupa base64 (image atau document)
            const match = message.match(/^data:(.+);base64,(.+)$/);
            if (match) {
                const mimetype = match[1];
                const base64Data = match[2];
                const buffer = Buffer.from(base64Data, 'base64');

                if (mimetype.startsWith('image/')) {
                    logger('info', `[${transactionId}-IMAGE] Mengirim gambar ke ${groupId}`);
                    await botSock.sendMessage(groupId, { image: buffer, mimetype });
                } else {
                    logger('info', `[${transactionId}-DOC] Mengirim dokumen ke ${groupId}`);
                    await botSock.sendMessage(groupId, { document: buffer, mimetype });
                }
            } else {
                logger('info', `[${transactionId}-TEXT] Mengirim teks ke ${groupId}`);
                await botSock.sendMessage(groupId, { text: `${transactionId}\n\n\n${message}` });
            }

            const sendEndTime = Date.now(); // End stopwatch per message
            const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

            logger('info', `[${transactionId}] Berhasil kirim ke ${groupId} dalam ${elapsedPerMessage.toFixed(3)} detik`);

            results.push({
                number: groupId,
                success: true,
                response_time_seconds: Number(elapsedPerMessage.toFixed(3))
            });

        } catch (sendErr) {
            const sendEndTime = Date.now();
            const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

            logger('error', `[${transactionId}] Gagal kirim ke ${groupId} dalam ${elapsedPerMessage.toFixed(3)} detik: ${sendErr.message}`);

            results.push({
                number: groupId,
                success: false,
                error: sendErr.message,
                response_time_seconds: Number(elapsedPerMessage.toFixed(3))
            });
        }
    }

    return results;
}


function removeFailedRequest(requestData, callback) {
    const failedRequestsFile = path.join(__dirname, 'failed_requests.json');

    fs.readFile(failedRequestsFile, (err, fileData) => {
        if (err) {
            return callback(err);
        }

        let failedRequests = [];
        if (fileData.length > 0) {
            failedRequests = JSON.parse(fileData);
        }

        const updatedRequests = failedRequests.filter(request => {
            return !(
                request.transactionId === requestData.transactionId &&
                JSON.stringify(request.number) === JSON.stringify(requestData.number) &&
                request.message === requestData.message
            );
        });

        fs.writeFile(failedRequestsFile, JSON.stringify(updatedRequests, null, 2), (err) => {
            if (err) {
                return callback(err);
            }
            callback(null);
        });
    });
}


// Endpoint untuk mengirim ulang request yang gagal
const { promisify } = require('util');

const readFileAsync = promisify(fs.readFile);


app.post('/resend-failed', async (req, res) => {
    const failedRequestsFile = path.join(__dirname, 'failed_requests.json');

    try {
        const fileData = await readFileAsync(failedRequestsFile);
        let failedRequests = [];

        if (fileData.length > 0) {
            failedRequests = JSON.parse(fileData);
        }

        const allResults = [];

        for (const failedRequest of failedRequests) {
            const { transactionId, number, message } = failedRequest;
            logger('info', `[${transactionId}] Mengirim ulang request yang gagal`);

            const resendResult = await resendFailedRequest({ number, message }, transactionId);
            allResults.push({ transactionId, ...resendResult });

            for (const result of resendResult) {
                if (result.success) {
                    console.log('REMOVE DATA:', failedRequest);
                    removeFailedRequest(failedRequest, (err) => {
                        if (err) {
                            logger('error', `Gagal menghapus request yang berhasil: ${err.message}`);
                        } else {
                            logger('info', `Request berhasil dihapus setelah dikirim ulang`);
                        }
                    });
                } else {
                    console.log('GAGAL KIRIM ULANG:', result);
                }
            }
        }

        res.status(200).json({
            message: 'Request yang gagal telah diproses.',
            results: allResults,
        });

    } catch (err) {
        logger('error', `Gagal memproses resend: ${err.message}`);
        res.status(500).json({ error: 'Gagal memproses resend-failed', details: err.message });
    }
});

async function phoneNumberFormatter(number){
    //1 Menghilangkan karakter selain angka 0812-123-456
    //let formatted = number.replace(/\D/g, '');
    if(number === undefined) return 0;
    let formatted = number.replace(/[^0-9\-]/g, '');
    //2 Menghilangkan prefix 0, kemudian diganti dengan 62
    if(formatted.startsWith('0')){
        formatted = '62' + formatted.substr(1);
    }

    //3 Tambahkan jika tidak diakhiri @c.us
    if(!formatted.endsWith('@c.us') || !formatted.endsWith('@g.us')){
        if(formatted.length >= 18){
            formatted = formatted + '@g.us';
        } else {
            formatted = formatted + '@c.us';
        }
    }

    return formatted;
}


app.post('/send-message', async (req, res) => {
    const startTime = Date.now();
    const transactionId = generateTransactionId("MSS");

    let { number, message } = req.body;
    number = await phoneNumberFormatter(number)


    if (!number || !message) {
        logger('error', `[${transactionId}] Parameter 'number' dan 'message' diperlukan`);
        return res.status(400).json({ error: 'Parameter number dan message diperlukan!' });
    }



    // Kalau number bukan array, ubah jadi array supaya aman
    if (!Array.isArray(number)) {
        number = [number];
    }

    number = [...new Set(number)];


    if (number.length > 10) {
        logger('error', `[${transactionId}] Max number adalah 10 Receipent`);
        return res.status(400).json({ error: 'Max number adalah 10 Receipent' });
    }
    try {
        const results = [];

        for (const groupId of number) {
            logger('info', `[${transactionId}] Mencari bot aktif untuk grup: ${groupId}`);
            const botSock = getNextBotForGroup(groupId);

            if (!botSock || !botSock.sendMessage) {
                logger('warn', `[${transactionId}] Tidak ada bot operasi yang aktif di grup ${groupId}`);
                results.push({ number: groupId, success: false, error: `Tidak ada bot aktif di grup ${groupId}`, response_time_seconds: 0 });
                continue;
            }

            const sendStartTime = Date.now(); // <-- start stopwatch per message

            try {
                const match = message.match(/^data:(.+);base64,(.+)$/);
                if (match) {
                    const mimetype = match[1];
                    const base64Data = match[2];
                    const buffer = Buffer.from(base64Data, 'base64');

                    if (mimetype.startsWith('image/')) {
                        logger('info', `[${transactionId}-IMAGE] Mengirim gambar ke ${groupId}`);
                        await botSock.sendMessage(groupId, { image: buffer, mimetype });
                    } else {
                        logger('info', `[${transactionId}-DOC] Mengirim dokumen ke ${groupId}`);
                        await botSock.sendMessage(groupId, { document: buffer, mimetype });
                    }
                } else {
                    logger('info', `[${transactionId}-TEXT] Mengirim teks ke ${groupId}`);
                    await botSock.sendMessage(groupId, { text: transactionId + "\n\n\n" + message });
                }

                const sendEndTime = Date.now(); // <-- end stopwatch per message
                const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

                logger('info', `[${transactionId}] Berhasil kirim ke ${groupId} dalam ${elapsedPerMessage.toFixed(3)} detik`);

                results.push({
                    number: groupId,
                    success: true,
                    response_time_seconds: Number(elapsedPerMessage.toFixed(3))
                });

            } catch (sendErr) {
                const sendEndTime = Date.now();
                const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

                logger('error', `[${transactionId}] Gagal kirim ke ${groupId} dalam ${elapsedPerMessage.toFixed(3)} detik: ${sendErr.message}`);

                results.push({
                    number: groupId,
                    success: false,
                    error: sendErr.message,
                    response_time_seconds: Number(elapsedPerMessage.toFixed(3))
                });
            }
        }

        const endTime = Date.now();
        const elapsedSeconds = (endTime - startTime) / 1000;

        logger('info', `[${transactionId}] Selesai kirim semua pesan dalam ${elapsedSeconds.toFixed(3)} detik`);

        res.json({
            success: true,
            transaction_id: transactionId,
            response_time_seconds: Number(elapsedSeconds.toFixed(3)),
            results,  // <-- ini hasil per number
            req_time: formatDate(startTime),
            res_time: formatDate(endTime)
        });
        // saveFailedRequest(req.body, transactionId);


    } catch (err) {
        logger('error', `[${transactionId}] Error global: ${err.message}`);
        saveFailedRequest(req.body, transactionId);
        res.status(500).json({ error: 'Gagal mengirim pesan', transaction_id: transactionId });
    }
});



app.post('/addbot', async (req, res) => {
    try {
        const { botname } = req.body;

        if (!botname) {
            return res.status(400).json({ error: 'Parameter botname diperlukan!' });
        }

        const qrBase64 = await startOperationBotAPI(botname);
        //await reconnectBot()
        if (qrBase64) {
            res.json({ success: true, message: `Bot ${botname} berhasil dimulai. Scan QR ini untuk login.`, qr: qrBase64 });
        } else {
            res.status(500).json({ error: 'Gagal menghasilkan QR Code.' });
        }

    } catch (err) {
        logger.error('Gagal menambahkan bot:', err);
        res.status(500).json({ error: 'Gagal menambahkan bot.' });
    }
});

app.post('/bot-status', async (req, res) => {
    try {
        const { number } = req.body;
        await testConnection(number)
        const status = await getBotStatusList(number);
        res.json({
            success: true,
            data: status
        });
    } catch (err) {
        logger('error', 'Gagal mengambil status bot:', err);
        res.status(500).json({ error: 'Gagal mengambil status bot.' });
    }
});

// Setup penyimpanan multer ke disk
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, './uploads/'); // Pastikan folder uploads sudah ada
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + file.originalname;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage });

app.post('/send-media', upload.single('file'), async (req, res) => {
    const startTime = Date.now();
    const transactionId = generateTransactionId("MSD");

    const { number, message } = req.body;
    const file = req.file;

    if (!number || !file) {
        logger('error', `[${transactionId}] Parameter 'number' dan 'file' diperlukan`);
        return res.status(400).json({ error: 'Parameter number dan file diperlukan.' });
    }

    const filePath = file.path;
    const mimetype = file.mimetype;

    try {
        logger('info', `[${transactionId}] Mencari bot aktif untuk grup: ${number}`);
        const botSock = getNextBotForGroup(number);

        if (!botSock || !botSock.sendMessage) {
            logger('warn', `[${transactionId}] Tidak ada bot operasi yang aktif di grup ${number}`);
            return res.status(404).json({ error: `Tidak ada bot operasi yang aktif di grup ${number}.` });
        }

        let mediaType;
        if (mimetype.startsWith('image/')) mediaType = 'image';
        else if (mimetype.startsWith('video/')) mediaType = 'video';
        else if (mimetype.startsWith('audio/')) mediaType = 'audio';
        else mediaType = 'document'; // default ke dokumen

        logger('info', `[${transactionId}-${mediaType.toUpperCase()}] Mengirim ${mediaType} (mime: ${mimetype}) ke ${number}`);

        await botSock.sendMessage(number, {
            [mediaType]: { url: path.resolve(filePath) },
            caption: message || '',
            mimetype: mimetype
        });

        const endTime = Date.now();
        const elapsedSeconds = (endTime - startTime) / 1000;

        logger('info', `[${transactionId}] Media berhasil dikirim dalam ${elapsedSeconds.toFixed(3)} detik`);

        res.json({
            success: true,
            transaction_id: transactionId,
            message: `Media berhasil dikirim ke ${number}`,
            response_time_seconds: Number(elapsedSeconds.toFixed(3)),
            req_time: formatDate(startTime),
            res_time: formatDate(endTime)
        });

    } catch (error) {
        logger('error', `[${transactionId}] Gagal mengirim media: ${error.message}`);
        res.status(500).json({ error: 'Gagal mengirim media.', transaction_id: transactionId });
    } finally {
        // Hapus file setelah berhasil atau error
        fs.unlink(filePath, (err) => {
            if (err) {
                logger('error', `[${transactionId}] Gagal hapus file temporary: ${err.message}`);
            } else {
                logger('info', `[${transactionId}] File temporary berhasil dihapus: ${filePath}`);
            }
        });
    }
});

app.post('/send-media-from-url', upload.single('file'), async (req, res) => {
    const { number, url } = req.body;
    const transactionId = generateTransactionId("MSU");
    const startTime = Date.now();

    if (!number || !url) {
        logger('error', `[${transactionId}] Parameter 'number' dan 'url' diperlukan`);
        return res.status(400).json({ error: 'Parameter number dan url diperlukan!' });
    }

    try {
        logger('info', `[${transactionId}] Mendownload file dari URL: ${url}`);

        // Mendownload file dari URL
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const fileBuffer = response.data;
        const contentType = response.headers['content-type'];

        // Cek apakah MIME type adalah image
        if (!contentType.startsWith('image/')) {
            logger('warn', `[${transactionId}] URL bukan gambar (content-type: ${contentType})`);
            return res.status(400).json({ error: 'URL tidak menunjuk pada gambar.' });
        }

        // Simpan file sementara dengan Multer
        const tempFilePath = path.join(__dirname, 'uploads', `${Date.now()}-image.${contentType.split('/')[1]}`);
        fs.writeFileSync(tempFilePath, fileBuffer);

        const botSock = getNextBotForGroup(number);
        if (!botSock || !botSock.sendMessage) {
            logger('warn', `[${transactionId}] Tidak ada bot operasi yang aktif di grup ${number}`);
            fs.unlinkSync(tempFilePath);  // Hapus file setelah gagal
            return res.status(404).json({ error: `Tidak ada bot operasi yang aktif di grup ${number}.` });
        }

        logger('info', `[${transactionId}] Mengirim gambar ke ${number}`);

        // Kirim gambar ke grup WhatsApp
        await botSock.sendMessage(number, {
            image: fs.readFileSync(tempFilePath),
            mimetype: contentType
        });

        // Hapus file setelah berhasil dikirim
        fs.unlinkSync(tempFilePath);

        const endTime = Date.now();
        const elapsedSeconds = (endTime - startTime) / 1000;

        logger('info', `[${transactionId}] Media berhasil dikirim dalam ${elapsedSeconds.toFixed(3)} detik`);

        res.json({
            success: true,
            transaction_id: transactionId,
            message: `Media berhasil dikirim ke ${number}`,
            response_time_seconds: Number(elapsedSeconds.toFixed(3)),
            req_time: formatDate(startTime),
            res_time: formatDate(endTime)
        });

    } catch (error) {
        logger('error', `[${transactionId}] Gagal mendownload atau mengirim media: ${error.message}`);
        res.status(500).json({ error: 'Gagal mendownload atau mengirim media.', transaction_id: transactionId });
    }
});





const PORT = 8008;
app.listen(PORT, () => {
    logger('info', `API berjalan di port ${PORT}`);
});
