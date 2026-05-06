const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

function getMediaKey(mimetype = '') {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    return 'document';
}

function normalizeContentType(headers = {}) {
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    return String(contentType).split(';')[0].trim();
}

function buildTextPayload(payload = {}) {
    const message = payload.message ?? payload.text ?? '';
    if (payload.transactionId) {
        return `${payload.transactionId}\n\n\n${message}`;
    }
    return message;
}

function buildMediaMessage({ mediaKey, mediaValue, caption, mimetype }) {
    const message = {
        [mediaKey]: mediaValue,
        mimetype
    };

    if (caption) {
        message.caption = caption;
    }

    return message;
}

async function sendJob({ job, sock, axiosClient = axios, fsModule = fs, pathModule = path }) {
    if (!job || !job.type) {
        throw new Error('Message job type is required');
    }
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Error('A socket with sendMessage is required');
    }

    const startedAt = Date.now();
    const payload = job.payload || {};
    let message;

    if (job.type === 'text') {
        message = { text: buildTextPayload(payload) };
    } else if (job.type === 'media_upload') {
        if (!payload.filePath) {
            throw new Error('media_upload payload.filePath is required');
        }
        const mimetype = payload.mimetype || 'application/octet-stream';
        const mediaKey = getMediaKey(mimetype);
        message = buildMediaMessage({
            mediaKey,
            mediaValue: { url: pathModule.resolve(payload.filePath) },
            caption: payload.caption,
            mimetype
        });
    } else if (job.type === 'media_url') {
        if (!payload.url) {
            throw new Error('media_url payload.url is required');
        }
        const response = await axiosClient.get(payload.url, { responseType: 'arraybuffer' });
        const mimetype = normalizeContentType(response.headers) || 'application/octet-stream';
        const mediaKey = getMediaKey(mimetype);
        const mediaBuffer = Buffer.isBuffer(response.data)
            ? response.data
            : Buffer.from(response.data);
        message = buildMediaMessage({
            mediaKey,
            mediaValue: mediaBuffer,
            caption: payload.caption,
            mimetype
        });
    } else {
        throw new Error(`Unsupported message job type: ${job.type}`);
    }

    await sock.sendMessage(job.target_id, message);

    return {
        responseTimeSeconds: (Date.now() - startedAt) / 1000
    };
}

module.exports = {
    sendJob
};
