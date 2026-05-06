
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { startAdminBot, startSingleAdminBot } = require('./bots/adminBot');
const { checkHeartbeatFromFile } = require('./bots/hertbeat');
const stats = require("./utils/statmanager");
const db = require("./utils/db");
const util = require('util')

const operationBot = require('./bots/operationBot');
const { getOperationSock, getNextBotForGroup, reconnectBot, startOperationBotAPI, getBotStatusList, disconnectBotForce, reconnectSingleBotAPI, getNextBotForIndividual, stopOperationBot, getAllGroups } = operationBot;
const { authMiddleware } = require('./utils/midleware');
const authRoutes = require('./routes/auth');
const tenantRoutes = require('./routes/tenants');
const commandRoutes = require('./routes/commands');
const scheduleRoutes = require('./routes/schedules');
const templateRoutes = require('./routes/templates');
const webhookRoutes = require('./routes/webhook');
const operationsRoutes = require('./routes/operations');
const { initScheduler } = require('./utils/scheduler');
const { seedSuperAdmin } = require('./utils/seed');
const { verifyToken } = require('./utils/auth');
const { ensureOperationsSchema } = require('./services/schemaService');
const queueService = require('./services/queueService');
const { startDeliveryWorker } = require('./services/deliveryWorker');
const { createRoutingService } = require('./services/routingService');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const mime = require('mime-types');


// Suppress noisy libsignal logs (Bad MAC, Closing session — normal Signal protocol behavior)
const _origLog = console.log;
const _origErr = console.error;
const SIGNAL_NOISE = ['Bad MAC', 'Closing session', 'Closing open session', 'Closing stale open session', 'Failed to decrypt'];
console.log = (...args) => {
    if (args.some(a => typeof a === 'string' && SIGNAL_NOISE.some(n => a.includes(n)))) return;
    _origLog.apply(console, args);
};
console.error = (...args) => {
    if (args.some(a => typeof a === 'string' && SIGNAL_NOISE.some(n => a.includes(n)))) return;
    _origErr.apply(console, args);
};

process.on('uncaughtException', (err) => {
    _origErr('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:5173'],
        credentials: true
    }
});

app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(express.json());
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:5173'],
    credentials: true
}));
app.use(authMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/commands', commandRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api', operationsRoutes);

function getBlockedList() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'blocked.json'), 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Failed to read blocked.json:", err);
        return [];
    }
}

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
    const epochTime = Math.floor(Date.now() / 1000);

    return `${code}-${todayDate}-${currentTime}-${epochTime}`;
}

const logDir = './logs';

const infoLogFile = path.join(logDir, `success-wa-history-${todayDate}.log`);
const errorLogFile = path.join(logDir, `error-wa-${todayDate}.log`);
const warnLogFile = path.join(logDir, `warn-wa-history-${todayDate}.log`);
const messLogFile = path.join(logDir, `req-res-${todayDate}.log`);



if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

function logger(type, message) {
    const timestamp = formatDate(new Date());
    const logMessage = `[${timestamp}] [${type.toUpperCase()}] ${message}`;

    switch (type) {
        case 'info':
            console.log(logMessage);
            writeLogToFile(infoLogFile, logMessage);
            break;
        case 'error':
            console.error(logMessage);
            writeLogToFile(errorLogFile, logMessage);
            break;
        case 'warn':
            console.warn(logMessage);
            writeLogToFile(warnLogFile, logMessage);
            break;
        case 'message':
            console.log(logMessage);
            writeLogToFile(messLogFile, logMessage);
            break;
        default:
            console.log(logMessage);
            break;
    }
}

function writeLogToFile(filePath, logMessage) {
    fs.appendFile(filePath, logMessage + '\n', (err) => {
        if (err) {
            console.error(`Failed to write to file: ${filePath}`, err);
        }
    });
}


async function saveFailedRequest(data, transactionId, tenantId) {
    try {
        await db.query(
            `INSERT INTO failed_requests (tenant_id, transaction_id, target_numbers, message, error)
             VALUES ($1, $2, $3, $4, $5)`,
            [tenantId, transactionId, JSON.stringify(data.number || []), data.message || '', data.error || '']
        );
    } catch (err) {
        console.error('Failed to save failed request:', err.message);
    }
}

async function resendFailedRequest(reqBody, transactionId, tenantId) {
    let { number, message } = reqBody;

    if (!number || !message) {
        logger('error', `[${transactionId}] REQ missing required params: number and message`);
        return { success: false, error: 'Parameters number and message are required' };
    }

    if (!Array.isArray(number)) {
        number = [number];
    }

    if (number.length > 10) {
        logger('error', `[${transactionId}] REQ rejected — max 10 recipients allowed`);
        return { success: false, error: 'Maximum 10 recipients allowed' };
    }

    const results = [];

    for (const groupId of number) {
        logger('info', `[${transactionId}] RESEND target=${groupId} — finding active bot`);
        const botSock = getNextBotForGroup(groupId, tenantId);

        if (!botSock || !botSock.sendMessage) {
            logger('warn', `[${transactionId}] RESEND target=${groupId} status=FAIL — no active bot`);
            results.push({ number: groupId, success: false, error: `No active bot for group ${groupId}`, response_time_seconds: 0 });
            continue;
        }

        const sendStartTime = Date.now();

        try {
            const match = message.match(/^data:(.+);base64,(.+)$/);
            if (match) {
                const mimetype = match[1];
                const base64Data = match[2];
                const buffer = Buffer.from(base64Data, 'base64');

                if (mimetype.startsWith('image/')) {
                    logger('info', `[${transactionId}] SENDING type=IMAGE target=${groupId}`);
                    await botSock.sendMessage(groupId, { image: buffer, mimetype });
                } else {
                    logger('info', `[${transactionId}] SENDING type=DOCUMENT target=${groupId}`);
                    await botSock.sendMessage(groupId, { document: buffer, mimetype });
                }
            } else {
                logger('info', `[${transactionId}] SENDING type=TEXT target=${groupId}`);
                await botSock.sendMessage(groupId, { text: `${transactionId}\n\n\n${message}` });
            }

            const sendEndTime = Date.now();
            const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

            logger('info', `[${transactionId}] RESEND target=${groupId} status=OK time=${elapsedPerMessage.toFixed(3)}s`);

            results.push({
                number: groupId,
                success: true,
                response_time_seconds: Number(elapsedPerMessage.toFixed(3))
            });

        } catch (sendErr) {
            const sendEndTime = Date.now();
            const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

            logger('error', `[${transactionId}] RESEND target=${groupId} status=FAIL time=${elapsedPerMessage.toFixed(3)}s error="${sendErr.message}"`);

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


async function markFailedRequestRetried(transactionId) {
    try {
        await db.query(
            `UPDATE failed_requests SET retried = TRUE, retried_at = NOW() WHERE transaction_id = $1`,
            [transactionId]
        );
    } catch (err) {
        console.error('Failed to update failed request:', err.message);
    }
}


const { promisify } = require('util');

const readFileAsync = promisify(fs.readFile);

app.post('/api/hi', async (req, res) => {
    const startTime = Date.now();
    const transactionId = generateTransactionId("MSS");
    number = "120363419686014131@g.us"
    message = "!ho"


    if (!Array.isArray(number)) {
        number = [number];
    }

    number = [...new Set(number)];


    if (number.length > 10) {
        logger('error', `[${transactionId}] REQ rejected — max 10 recipients allowed`);
        return res.status(400).json({ error: 'Maximum 10 recipients allowed' });
    }
    try {
        const results = [];

        for (const groupId of number) {
            const botSock = getNextBotForGroup(groupId, req.user.tenantId);

            if (!botSock || !botSock.sendMessage) {
                results.push({ number: groupId, success: false, error: `No active bot for group ${groupId}`, response_time_seconds: 0 });
                continue;
            }

            const sendStartTime = Date.now();

            try {
                const match = message.match(/^data:(.+);base64,(.+)$/);
                if (match) {
                    const mimetype = match[1];
                    const base64Data = match[2];
                    const buffer = Buffer.from(base64Data, 'base64');

                    if (mimetype.startsWith('image/')) {
                        await botSock.sendMessage(groupId, { image: buffer, mimetype });
                    } else {
                        await botSock.sendMessage(groupId, { document: buffer, mimetype });
                    }
                } else {
                    await botSock.sendMessage(groupId, { text: message + " " + transactionId });
                }

                const sendEndTime = Date.now();
                const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

                logger('info', `[${transactionId}] SEND target=${groupId} type=TEXT status=OK time=${elapsedPerMessage.toFixed(3)}s`);

                results.push({
                    number: groupId,
                    success: true,
                    response_time_seconds: Number(elapsedPerMessage.toFixed(3))
                });

            } catch (sendErr) {
                const sendEndTime = Date.now();
                const elapsedPerMessage = (sendEndTime - sendStartTime) / 1000;

                logger('error', `[${transactionId}] SEND target=${groupId} type=TEXT status=FAIL error="${sendErr.message}" time=${elapsedPerMessage.toFixed(3)}s`);

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

        logger('info', `[${transactionId}] SEND completed targets=${number.length} success=${results.filter(r => r.success).length} failed=${results.filter(r => !r.success).length} total_time=${elapsedSeconds.toFixed(3)}s`);

        res.json({
            success: results[0].success,
            transaction_id: transactionId,
            response_time_seconds: Number(elapsedSeconds.toFixed(3)),
            results,
            req_time: formatDate(startTime),
            res_time: formatDate(endTime)
        });


    } catch (err) {
        logger('error', `[${transactionId}] Error global: ${err.message}`);
        saveFailedRequest(req.body, transactionId, req.user.tenantId);
        res.status(500).json({ error: 'Failed to send message', transaction_id: transactionId });
    }
});

app.post('/api/resend-failed', async (req, res) => {
    try {
        const tenantFilter = req.user.role === 'super_admin' ? '' : 'AND tenant_id = $1';
        const params = req.user.role === 'super_admin' ? [] : [req.user.tenantId];
        const result = await db.query(
            `SELECT id, transaction_id, target_numbers, message, tenant_id FROM failed_requests WHERE retried = FALSE ${tenantFilter} ORDER BY created_at`,
            params
        );

        const allResults = [];

        for (const row of result.rows) {
            const number = row.target_numbers;
            const message = row.message;
            const transactionId = row.transaction_id;

            logger('info', `[${transactionId}] RESEND target=${number} — retrying failed request`);
            const resendResult = await resendFailedRequest({ number, message }, transactionId, row.tenant_id);
            allResults.push({ transactionId, results: resendResult });

            const anySuccess = resendResult.some(r => r.success);
            if (anySuccess) {
                await markFailedRequestRetried(transactionId);
            }
        }

        res.status(200).json({
            success: true,
            message: `Processed ${allResults.length} failed requests`,
            results: allResults,
        });
    } catch (err) {
        logger('error', `Failed to process resend: ${err.message}`);
        res.status(500).json({ error: 'Failed to process resend-failed', details: err.message });
    }
});

async function phoneNumberFormatter(number) {
    if (number === undefined) return 0;
    let formatted = number.replace(/[^0-9\-]/g, '');
    if (formatted.startsWith('0')) {
        formatted = '62' + formatted.substr(1);
    }

    if (!formatted.endsWith('@c.us') || !formatted.endsWith('@g.us')) {
        if (formatted.length >= 18) {
            formatted = formatted + '@g.us';
        } else {
            formatted = formatted + '@c.us';
        }
    }

    return formatted;
}


app.post('/api/send-message', async (req, res) => {
    const startTime = Date.now();
    const transactionId = generateTransactionId("MSS");

    let { number, message, caption } = req.body;

    if (!number || !message) {
        logger('error', `[${transactionId}] REQ missing required params: number and message`);
        return res.status(400).json({ error: 'Parameters number and message are required' });
    }

    if (!Array.isArray(number)) number = [number];
    number = [...new Set(number)];

    if (number.length > 10) {
        logger('error', `[${transactionId}] REQ rejected — max 10 recipients allowed`);
        return res.status(400).json({ error: 'Maximum 10 recipients allowed' });
    }

    try {
        const targets = await normalizeQueuedTargets(number, transactionId);
        const jobs = await queueService.enqueueBulkMessageJobs({
            tenantId: req.user.tenantId,
            source: 'api',
            type: 'text',
            targets,
            payload: { message, caption, transactionId }
        });
        const endTime = Date.now();
        const elapsedSeconds = (endTime - startTime) / 1000;

        logger('info', `[${transactionId}] QUEUED type=TEXT targets=${targets.length} total_time=${elapsedSeconds.toFixed(3)}s`);
        logger('message', `[${transactionId}] REQ target=${targets[0]} message_preview="${(message || '').substring(0, 50)}" status=QUEUED`);

        res.json({
            success: true,
            status: 'queued',
            job_ids: jobs.map(job => job.id),
            queued: jobs.length,
            transaction_id: transactionId
        });
    } catch (err) {
        logger('error', `[${transactionId}] QUEUE failed: ${err.message}`);
        await saveFailedRequest({ number, message, error: err.message }, transactionId, req.user.tenantId);
        res.status(400).json({ success: false, error: err.message, transaction_id: transactionId });
    }
});


async function normalizeQueuedTargets(rawTargets, transactionId) {
    const blockedList = getBlockedList();
    const targets = [];

    for (const rawTarget of rawTargets) {
        let targetNumber = String(rawTarget || '').trim();
        if (!targetNumber) {
            throw new Error('Target number cannot be empty');
        }
        if (!targetNumber.includes('@')) {
            targetNumber = await phoneNumberFormatter(targetNumber);
        }

        if (targetNumber.endsWith('@c.us')) {
            logger('error', `[${transactionId}] REJECTED target=${targetNumber} — personal numbers not allowed`);
            throw new Error("Please don't send to personal number");
        }

        if (blockedList.includes(targetNumber)) {
            logger('warn', `[${transactionId}] BLOCKED target=${targetNumber} — group is on block list`);
            throw new Error('Group is blocked, please tell to administrator');
        }

        targets.push(targetNumber);
    }

    return [...new Set(targets)];
}


async function handleSingleTarget(rawNumber, message, caption, transactionId, tenantId) {
    const sendStartTime = Date.now();

    const blockedList = getBlockedList();

    let targetNumber = rawNumber;

    if (!targetNumber.includes('@')) {
        targetNumber = await phoneNumberFormatter(targetNumber);
    }

    if (blockedList.includes(targetNumber)) {
        logger('warn', `[${transactionId}] BLOCKED target=${targetNumber} — group is on block list`);
        return {
            number: targetNumber,
            success: false,
            error: "Group is blocked, please tell to administrator",
            response_time_seconds: 0
        };
    }

    const maxRetry = 10;
    const retryDelay = 100000;

    try {

        let botSock = null;
        let attempt = 0;

        while (attempt <= maxRetry) {
            if (targetNumber.endsWith('@g.us')) {
                logger('info', `[${transactionId}] ROUTE attempt=${attempt + 1} target=${targetNumber} — finding active bot`);
                botSock = getNextBotForGroup(targetNumber, tenantId);
            } else if (targetNumber.endsWith('@c.us')) {
                logger('error', `[${transactionId}] REJECTED target=${targetNumber} — personal numbers not allowed`);
                return {
                    number: targetNumber,
                    success: false,
                    error: "Please don't send to personal number"
                }
            }

            if (botSock && botSock.sendMessage) {
                break;
            }

            if (attempt < maxRetry) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }

            attempt++;
        }

        if (!botSock || !botSock.sendMessage) {
            logger('warn', `[${transactionId}] NO_BOT target=${targetNumber} — no active bot after ${attempt} attempts`);
            return {
                number: targetNumber,
                success: false,
                error: `No active bot for ${targetNumber} after ${attempt} attempts`,
                response_time_seconds: 0
            };
        }

        const result = await sendMessageWithRetry(botSock, targetNumber, message, caption, transactionId, tenantId);
        return result;

    } catch (err) {
        const elapsed = (Date.now() - sendStartTime) / 1000;
        logger('error', `[${transactionId}] FAILED target=${rawNumber} time=${elapsed.toFixed(3)}s error="${err.message}"`);
        return {
            number: rawNumber,
            success: false,
            error: err.message,
            response_time_seconds: Number(elapsed.toFixed(3))
        };
    }
}


function getBotInfo(sock) {
    return {
        number: sock.user.id.split(':')[0],
        connected: sock.ws.socket._readyState === 1,
        platform: sock.authState.creds.platform,
        registered: sock.authState.creds.registered,
        syncTime: sock.authState.creds.lastAccountSyncTimestamp
            ? new Date(sock.authState.creds.lastAccountSyncTimestamp * 1000)
            : null,
        wsUrl: sock.ws.url.hostname
    }
}
async function sendMessageWithRetry(botSock, targetNumber, message, caption, transactionId, tenantId, maxRetry = 10) {
    const sendStartTime = Date.now();
    let attempt = 0;

    while (attempt <= maxRetry) {
        try {
            await sendMessage(botSock, targetNumber, message, caption, transactionId, attempt);
            const elapsed = (Date.now() - sendStartTime) / 1000;
            let botHealth = getBotInfo(botSock)
            logger('info', `[${transactionId}] DELIVERED target=${targetNumber} bot=${botHealth.number} time=${elapsed.toFixed(3)}s`);
            stats.increment(botHealth.number, tenantId);
            return {
                number: targetNumber,
                success: true,
                retried: attempt,
                response_time_seconds: Number(elapsed.toFixed(3))
            };
        } catch (err) {
            const isRetryable = (err.message || '').includes('Connection Failed') ||
                (err.message || '').includes('Connection Closed') ||
                (err.message || '').includes('Timed Out');

            logger('warn', `[${transactionId}] RETRY attempt=${attempt + 1} target=${targetNumber} error="${err.message}" — switching bot`);

            if (!isRetryable || attempt === maxRetry) {
                const elapsed = (Date.now() - sendStartTime) / 1000;
                logger(
                    'error',
                    `[${transactionId}] FAILED target=${targetNumber} attempts=${attempt + 1} time=${elapsed.toFixed(3)}s error="${err.message}"\n` +
                    JSON.stringify(err, Object.getOwnPropertyNames(err), 2)
                );
                return {
                    number: targetNumber,
                    success: false,
                    error: err.message,
                    retried: attempt,
                    response_time_seconds: Number(elapsed.toFixed(3))
                };
            }

            if (targetNumber.endsWith('@g.us')) {
                logger('info', `[${transactionId}] BOT_RETRY target=${targetNumber} attempt=${attempt + 1} switching_bot=true`);
                botSock = getNextBotForGroup(targetNumber, tenantId);
            } else if (targetNumber.endsWith('@c.us')) {
                logger('info', `[${transactionId}] BOT_RETRY target=${targetNumber} attempt=${attempt + 1} switching_bot=true`);
                botSock = getNextBotForIndividual(targetNumber, tenantId);
            }

            if (!botSock || !botSock.sendMessage) {
                logger('error', `[${transactionId}] NO_BOT target=${targetNumber} — no bot available on attempt ${attempt + 1}`);
                return {
                    number: targetNumber,
                    success: false,
                    error: `No bot available on attempt ${attempt + 1}`,
                    retried: attempt,
                    response_time_seconds: Number(((Date.now() - sendStartTime) / 1000).toFixed(3))
                };
            }

            attempt++;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
}


async function sendMessage(botSock, targetNumber, message, caption, transactionId, attempt) {
    const prefix = `[${transactionId}]`;
    const match = message.match(/^data:([^;]+);base64,(.+)$/s);

    if (match) {
        const mimetype = match[1];
        const base64Data = match[2].replace(/\s/g, '');
        const buffer = Buffer.from(base64Data, 'base64');

        if (mimetype.startsWith('image/')) {
            logger('info', `${prefix} SENDING type=IMAGE target=${targetNumber} attempt=${attempt + 1}`);
            await botSock.sendMessage(targetNumber, {
                image: buffer,
                caption: `${transactionId}\n\n\n${caption || ''}`
            });
        } else {
            logger('info', `${prefix} SENDING type=DOCUMENT target=${targetNumber} attempt=${attempt + 1}`);
            await botSock.sendMessage(targetNumber, {
                document: buffer,
                mimetype,
                fileName: `${transactionId}.${mime.extension(mimetype) || 'bin'}`
            });
        }
    } else {
        logger('info', `${prefix} SENDING type=TEXT target=${targetNumber} attempt=${attempt + 1}`);
        await botSock.sendMessage(targetNumber, {
            text: `${transactionId}\n\n\n${message}`
        });
    }
}



app.post('/api/disconnect', async (req, res) => {
    const { botId } = req.body;

    if (!botId) {
        return res.status(400).json({ success: false, error: 'botId is required' });
    }

    const result = await disconnectBotForce(botId, req.user.tenantId);
    res.json(result);
});

app.post('/api/deletebot', async (req, res) => {
    const { botId } = req.body;

    if (!botId) {
        return res.status(400).json({ success: false, error: 'botId is required' });
    }

    try {
        await stopOperationBot(botId, req.user.tenantId);
        res.json({ success: true, message: `Bot ${botId} has been deleted` });
    } catch (err) {
        res.status(500).json({ success: false, error: `Failed to delete bot: ${err.message}` });
    }
});



app.post('/api/addbot', async (req, res) => {
    try {
        const { botname, is_admin_bot } = req.body;
        if (!botname) {
            return res.status(400).json({ success: false, error: 'botname is required' });
        }

        const tenantId = req.user.tenantId;
        const isAdmin = is_admin_bot === true;

        // Register bot in DB
        await db.query(
            `INSERT INTO bot_status (tenant_id, bot_id, status, is_admin_bot)
             VALUES ($1, $2, 'connecting', $3)
             ON CONFLICT (tenant_id, bot_id) DO UPDATE SET is_admin_bot = $3`,
            [tenantId, botname, isAdmin]
        );

        if (isAdmin) {
            // Set as tenant's admin bot
            await db.query('UPDATE tenants SET admin_bot_id = $1 WHERE id = $2', [botname, tenantId]);

            // Start as admin bot (with command handler, NOT as operation bot)
            const tenantResult = await db.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
            const tenant = tenantResult.rows[0];

            let qrBase64 = null;
            if (tenant) {
                const result = await startSingleAdminBot(tenant);
                qrBase64 = result?.qr || null;
            }

            res.json({
                success: true,
                message: `Admin bot ${botname} started. Scan QR to connect.`,
                qr: qrBase64,
                is_admin_bot: true
            });
        } else {
            const qrBase64 = await startOperationBotAPI(botname, tenantId);
            if (qrBase64) {
                res.json({ success: true, message: `Bot ${botname} started. Scan QR to connect.`, qr: qrBase64 });
            } else {
                res.json({ success: true, message: `Bot ${botname} started. It may already be connected.` });
            }
        }
    } catch (err) {
        logger('error', `Failed to add bot: ${err.message}`);
        res.status(500).json({ success: false, error: `Failed to add bot: ${err.message}` });
    }
});

app.post('/api/restart', async (req, res) => {
    try {
        const { botname } = req.body;

        if (!botname) {
            return res.status(400).json({ success: false, error: 'botname is required' });
        }

        const status = await reconnectSingleBotAPI(botname, req.user.tenantId);
        return res.status(200).json({ success: true, message: `Bot ${botname} is restarting` });

    } catch (err) {
        logger('error', `Failed to restart bot: ${err.message}`);
        res.status(500).json({ success: false, error: `Failed to restart bot: ${err.message}` });
    }
});

app.get('/api/bot-status', async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        let result;
        if (req.user.role === 'super_admin') {
            result = await db.query('SELECT bot_id, status, tenant_id FROM bot_status ORDER BY bot_id');
        } else {
            result = await db.query('SELECT bot_id, status FROM bot_status WHERE tenant_id = $1 ORDER BY bot_id', [tenantId]);
        }
        const active = result.rows.filter(r => r.status === 'open').map(r => r.bot_id);
        const inactive = result.rows.filter(r => r.status !== 'open').map(r => r.bot_id);
        res.json({ success: true, data: { active, inactive } });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to get bot status' });
    }
});

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'uploads'));
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + file.originalname;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage });

async function cleanupUploadedRequestFile(file, transactionId) {
    if (!file || !file.path) return;
    try {
        await fs.promises.unlink(file.path);
        logger('info', `[${transactionId}] CLEANUP uploaded file=${file.path}`);
    } catch (error) {
        logger('warn', `[${transactionId}] CLEANUP failed file=${file.path} error="${error.message}"`);
    }
}

function createTargetUploadPath(filePath, index) {
    const parsedPath = path.parse(filePath);
    return path.join(parsedPath.dir, `${parsedPath.name}-${index}${parsedPath.ext}`);
}

async function enqueueMediaUploadJobs({ tenantId, targets, file, caption, transactionId }) {
    if (targets.length === 1) {
        return queueService.enqueueBulkMessageJobs({
            tenantId,
            source: 'api',
            type: 'media_upload',
            targets,
            payload: {
                filePath: file.path,
                mimetype: file.mimetype,
                caption,
                transactionId
            }
        });
    }

    const jobs = [];
    const copiedFiles = [];
    const queuedFiles = new Set();

    try {
        for (const [index, targetId] of targets.entries()) {
            const targetFilePath = createTargetUploadPath(file.path, index + 1);
            await fs.promises.copyFile(file.path, targetFilePath);
            copiedFiles.push(targetFilePath);

            const job = await queueService.enqueueMessageJob({
                tenantId,
                source: 'api',
                type: 'media_upload',
                targetId,
                payload: {
                    filePath: targetFilePath,
                    mimetype: file.mimetype,
                    caption,
                    transactionId
                }
            });
            queuedFiles.add(targetFilePath);
            jobs.push(job);
        }
    } catch (error) {
        for (const copiedFile of copiedFiles) {
            if (queuedFiles.has(copiedFile)) continue;
            await cleanupUploadedRequestFile({ path: copiedFile }, transactionId);
        }
        throw error;
    }

    await cleanupUploadedRequestFile(file, transactionId);
    return jobs;
}

app.post('/api/send-media', upload.single('file'), async (req, res) => {
    const startTime = Date.now();
    const transactionId = generateTransactionId("MSD");

    let { number, message, caption } = req.body;
    const file = req.file;

    if (!number || !file) {
        logger('error', `[${transactionId}] REQ missing required params: number and file`);
        await cleanupUploadedRequestFile(file, transactionId);
        return res.status(400).json({ success: false, error: 'number and file are required' });
    }

    if (!Array.isArray(number)) number = [number];
    number = [...new Set(number)];

    if (number.length > 10) {
        logger('error', `[${transactionId}] REQ rejected — max 10 recipients allowed`);
        await cleanupUploadedRequestFile(file, transactionId);
        return res.status(400).json({ error: 'Maximum 10 recipients allowed' });
    }

    try {
        const targets = await normalizeQueuedTargets(number, transactionId);
        const jobs = await enqueueMediaUploadJobs({
            tenantId: req.user.tenantId,
            targets,
            file,
            caption: caption || message || '',
            transactionId
        });

        const endTime = Date.now();
        const elapsedSeconds = (endTime - startTime) / 1000;

        logger('info', `[${transactionId}] QUEUED type=MEDIA_UPLOAD targets=${targets.length} time=${elapsedSeconds.toFixed(3)}s`);

        res.json({
            success: true,
            status: 'queued',
            job_ids: jobs.map(job => job.id),
            queued: jobs.length,
            transaction_id: transactionId
        });

    } catch (error) {
        logger('error', `[${transactionId}] QUEUE media_upload status=FAIL error="${error.message}"`);
        await cleanupUploadedRequestFile(file, transactionId);
        res.status(400).json({ success: false, error: `Failed to queue media: ${error.message}`, transaction_id: transactionId });
    }
});

app.post('/api/send-media-from-url', upload.single('file'), async (req, res) => {
    let { number, url, message, caption } = req.body;
    const transactionId = generateTransactionId("MSU");
    const startTime = Date.now();

    if (!number || !url) {
        logger('error', `[${transactionId}] REQ missing required params: number and url`);
        return res.status(400).json({ success: false, error: 'number and url are required' });
    }

    if (!Array.isArray(number)) number = [number];
    number = [...new Set(number)];

    if (number.length > 10) {
        logger('error', `[${transactionId}] REQ rejected — max 10 recipients allowed`);
        return res.status(400).json({ error: 'Maximum 10 recipients allowed' });
    }

    try {
        const targets = await normalizeQueuedTargets(number, transactionId);
        const jobs = await queueService.enqueueBulkMessageJobs({
            tenantId: req.user.tenantId,
            source: 'api',
            type: 'media_url',
            targets,
            payload: {
                url,
                caption: caption || message || '',
                transactionId
            }
        });

        const endTime = Date.now();
        const elapsedSeconds = (endTime - startTime) / 1000;

        logger('info', `[${transactionId}] QUEUED type=MEDIA_URL targets=${targets.length} time=${elapsedSeconds.toFixed(3)}s`);

        res.json({
            success: true,
            status: 'queued',
            job_ids: jobs.map(job => job.id),
            queued: jobs.length,
            transaction_id: transactionId
        });

    } catch (error) {
        logger('error', `[${transactionId}] QUEUE media_url status=FAIL error="${error.message}"`);
        res.status(400).json({ success: false, error: `Failed to queue media: ${error.message}`, transaction_id: transactionId });
    }
});

function normalizeJid(jid) {
    return jid.replace(/:\d+@/, '@');
}

app.get('/api/list-my-groups', async (req, res) => {
    const startTime = Date.now();
    const transactionId = generateTransactionId("GRP-FETCH");

    try {
        const dummyGroupId = '120363419686014131@g.us';
        const sock = getNextBotForGroup(dummyGroupId, req.user.tenantId);

        if (!sock) {
            logger('warn', `[${transactionId}] No active bot for group fetch`);
            return res.status(400).json({
                success: false,
                transaction_id: transactionId,
                error: 'No active bot available'
            });
        }

        const groups = Object.values(
            await sock.groupFetchAllParticipating()
        );

        const responseTime = (Date.now() - startTime) / 1000;
        const botJid = sock.user.id;

        logger('info', `[${transactionId}] Fetched ${groups.length} groups`);

        return res.json({
            success: true,
            transaction_id: transactionId,
            group_count: groups.length,
            response_time_seconds: Number(responseTime.toFixed(3)),
            bot: {
                jid: botJid,
                number: botJid.split(':')[0]
            },
            groups: groups.map(g => {
                const botParticipant = g.participants.find(
                    p => p.id === botJid
                );

                const isBotAdmin =
                    botParticipant?.admin === 'admin' ||
                    botParticipant?.admin === 'superadmin';

                const botRole = botParticipant?.admin ?? 'member';

                return {
                    id: g.id,
                    name: g.subject,

                    member_count: g.participants.length,
                    admin_count: g.participants.filter(p =>
                        p.admin === 'admin' || p.admin === 'superadmin'
                    ).length,

                    bot_role: botRole,
                    is_bot_admin: isBotAdmin,

                    restrict: g.restrict === true,
                    owner: g.owner ?? null
                };
            })
        });

    } catch (err) {
        logger('error', `[${transactionId}] Failed to fetch groups: ${err.message}`);
        return res.status(500).json({
            success: false,
            transaction_id: transactionId,
            error: err.message
        });
    }
});


app.get('/api/stats/:date', async (req, res) => {
    const { date } = req.params;
    try {
        const data = await stats.getStatsByDate(date, req.user.tenantId);
        res.json({ success: true, date, data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read stats' });
    }
});

app.get('/api/logs/:type/:date', (req, res) => {
    const { type, date } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const search = req.query.search || '';

    const logFileMap = {
        'success': `success-wa-history-${date}.log`,
        'error': `error-wa-${date}.log`,
        'warn': `warn-wa-history-${date}.log`,
        'req-res': `req-res-${date}.log`
    };

    let filesToRead = [];
    if (type === 'all') {
        filesToRead = Object.entries(logFileMap).map(([t, f]) => ({ type: t, file: f }));
    } else {
        const fileName = logFileMap[type];
        if (!fileName) {
            return res.status(400).json({ error: 'Invalid log type. Use: all, success, error, warn, req-res' });
        }
        filesToRead = [{ type, file: fileName }];
    }

    try {
        let allLines = [];

        for (const { type: logType, file } of filesToRead) {
            const logFile = path.join(__dirname, 'logs', file);
            if (!fs.existsSync(logFile)) continue;
            const content = fs.readFileSync(logFile, 'utf-8');
            content.split('\n').filter(l => l.trim()).forEach(line => {
                allLines.push({ type: logType, text: line });
            });
        }

        if (type === 'all') {
            allLines.sort((a, b) => {
                const tsA = a.text.match(/\[(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}:\d{3})\]/);
                const tsB = b.text.match(/\[(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}:\d{3})\]/);
                if (!tsA || !tsB) return 0;
                return tsA[1].localeCompare(tsB[1]);
            });
        }

        if (search) {
            const q = search.toLowerCase();
            allLines = allLines.filter(l => l.text.toLowerCase().includes(q));
        }

        const totalLines = allLines.length;
        const start = (page - 1) * limit;
        const paginatedLines = allLines.slice(start, start + limit);

        res.json({
            success: true, type, date, page, limit, totalLines,
            totalPages: Math.ceil(totalLines / limit),
            lines: paginatedLines
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read log files' });
    }
});

app.get('/api/groups', (req, res) => {
    try {
        const groups = getAllGroups(req.user.tenantId);
        res.json({
            success: true,
            group_count: groups.length,
            groups: groups.map(g => ({
                id: g.id,
                name: g.name,
                member_count: g.member_count,
                bots: g.bots,
                is_blocked: false // TODO: tenant-scoped block list
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/groups/block', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const blockedFile = path.join(__dirname, 'blocked.json');
    let blockedList = [];
    try { blockedList = JSON.parse(fs.readFileSync(blockedFile, 'utf-8')); } catch (e) { blockedList = []; }
    if (blockedList.includes(groupId)) {
        return res.json({ success: true, message: 'Already blocked' });
    }
    blockedList.push(groupId);
    fs.writeFileSync(blockedFile, JSON.stringify(blockedList, null, 2));
    res.json({ success: true, message: `Group ${groupId} blocked` });
});

app.post('/api/groups/unblock', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const blockedFile = path.join(__dirname, 'blocked.json');
    let blockedList = [];
    try { blockedList = JSON.parse(fs.readFileSync(blockedFile, 'utf-8')); } catch (e) { blockedList = []; }
    blockedList = blockedList.filter(id => id !== groupId);
    fs.writeFileSync(blockedFile, JSON.stringify(blockedList, null, 2));
    res.json({ success: true, message: `Group ${groupId} unblocked` });
});

app.put('/api/tenant/profile', async (req, res) => {
    const { brand_name } = req.body;
    if (!brand_name) return res.status(400).json({ error: 'brand_name required' });
    try {
        await db.query('UPDATE tenants SET brand_name = $1 WHERE id = $2', [brand_name, req.user.tenantId]);
        res.json({ success: true, message: 'Brand updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/failed-requests', async (req, res) => {
    try {
        const tenantFilter = req.user.role === 'super_admin' ? '' : 'AND tenant_id = $1';
        const params = req.user.role === 'super_admin' ? [] : [req.user.tenantId];
        const result = await db.query(
            `SELECT transaction_id as "transactionId", target_numbers as number, message, created_at as saved_at, retried
             FROM failed_requests WHERE retried = FALSE ${tenantFilter} ORDER BY created_at DESC`,
            params
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read failed requests' });
    }
});

app.post('/api/groups/bulk-block', async (req, res) => {
    const { group_ids } = req.body;
    if (!group_ids || !Array.isArray(group_ids) || group_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'group_ids must be a non-empty array' });
    }
    res.json({ success: true, message: `${group_ids.length} groups blocked`, count: group_ids.length });
});

app.post('/api/groups/bulk-unblock', async (req, res) => {
    const { group_ids } = req.body;
    if (!group_ids || !Array.isArray(group_ids) || group_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'group_ids must be a non-empty array' });
    }
    res.json({ success: true, message: `${group_ids.length} groups unblocked`, count: group_ids.length });
});

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    try {
        const decoded = verifyToken(token);
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    const { tenantId, role } = socket.user;
    if (tenantId) socket.join(`tenant:${tenantId}`);
    if (role === 'super_admin') socket.join('super_admin');

    logger('info', `DASHBOARD connected client=${socket.id} tenant=${tenantId || 'super_admin'}`);

    socket.on('bot:add', async ({ botId }) => {
        if (!botId || !tenantId) return;
        logger('info', `DASHBOARD request=addbot bot=${botId} tenant=${tenantId}`);
        const qrBase64 = await startOperationBotAPI(botId, tenantId);
        if (qrBase64) {
            socket.emit('bot:qr', { botId, qr: qrBase64 });
        }
    });

    socket.on('disconnect', () => {
        logger('info', `DASHBOARD disconnected client=${socket.id}`);
    });
});

module.exports = { io };

const PORT = 8008;
let deliveryWorker;

function getDeliveryWorkerStartDelayMs(env = process.env) {
    if (env.DELIVERY_WORKER_START_DELAY_MS !== undefined) {
        const parsed = Number.parseInt(env.DELIVERY_WORKER_START_DELAY_MS, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return env.NODE_ENV === 'production' ? 30000 : 0;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function startDeliveryWorkerAfterWarmup({ delayMs, routingService }) {
    logger('info', `[DeliveryWorker] startup warm-up delay=${delayMs}ms`);
    if (delayMs > 0) {
        await delay(delayMs);
    }

    await queueService.requeuePendingJobs();
    deliveryWorker = startDeliveryWorker({
        queueService,
        routingService,
        workerId: `api-${process.pid}`
    });
    logger('info', '[DeliveryWorker] started');
}

async function startServer() {
    try {
        await ensureOperationsSchema();
        await seedSuperAdmin();
        await startAdminBot();
        checkHeartbeatFromFile();
        await initScheduler();

        const routingService = createRoutingService({ socketRegistry: operationBot });
        const workerStartDelayMs = getDeliveryWorkerStartDelayMs();

        server.listen(PORT, () => {
            logger('info', `ZYRON API server started on port ${PORT}`);
        });

        startDeliveryWorkerAfterWarmup({
            delayMs: workerStartDelayMs,
            routingService
        }).catch(error => {
            logger('error', `[DeliveryWorker] Failed to start: ${error.message}`);
            process.exit(1);
        });
    } catch (error) {
        logger('error', `Failed to start server: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
}

setInterval(() => {
    stats.flush();
}, 5 * 60 * 1000);

process.on("SIGINT", () => {
    logger("info", "Flushing stats before shutdown (SIGINT)...");
    stats.flush();
    if (deliveryWorker && typeof deliveryWorker.close === 'function') {
        deliveryWorker.close().catch(err => logger("error", `Failed to close delivery worker: ${err.message}`));
    }
    process.exit();
});

process.on("SIGTERM", () => {
    logger("info", "Flushing stats before shutdown (SIGTERM)...");
    stats.flush();
    if (deliveryWorker && typeof deliveryWorker.close === 'function') {
        deliveryWorker.close().catch(err => logger("error", `Failed to close delivery worker: ${err.message}`));
    }
    process.exit();
});

module.exports.getDeliveryWorkerStartDelayMs = getDeliveryWorkerStartDelayMs;
