const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

const MEDIA_URL_LIMIT_BYTES = 25 * 1024 * 1024;

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

function getDefaultUploadRoot(pathModule = path) {
    return process.env.UPLOAD_DIR || pathModule.join(__dirname, '..', 'uploads');
}

function isPathInside(parentPath, childPath, pathModule = path) {
    const relativePath = pathModule.relative(parentPath, childPath);
    return relativePath === '' || (
        relativePath &&
        !relativePath.startsWith('..') &&
        !pathModule.isAbsolute(relativePath)
    );
}

function realpathIfAvailable(targetPath, fsModule = fs) {
    if (fsModule && typeof fsModule.realpathSync === 'function') {
        return fsModule.realpathSync(targetPath);
    }
    return targetPath;
}

function resolveUploadPath({ filePath, uploadRoot, fsModule = fs, pathModule = path }) {
    const rootPath = pathModule.resolve(uploadRoot || getDefaultUploadRoot(pathModule));
    const resolvedPath = pathModule.resolve(filePath);
    const realRootPath = realpathIfAvailable(rootPath, fsModule);

    if (!isPathInside(rootPath, resolvedPath, pathModule)) {
        throw new Error('media_upload payload.filePath is outside upload root');
    }
    if (!fsModule.existsSync(resolvedPath)) {
        throw new Error('media_upload payload.filePath not found');
    }

    const realFilePath = realpathIfAvailable(resolvedPath, fsModule);
    if (!isPathInside(realRootPath, realFilePath, pathModule)) {
        throw new Error('media_upload payload.filePath is outside upload root');
    }

    return resolvedPath;
}

async function sendJob({
    job,
    sock,
    axiosClient = axios,
    fsModule = fs,
    pathModule = path,
    uploadRoot
}) {
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
        const mediaPath = resolveUploadPath({
            filePath: payload.filePath,
            uploadRoot,
            fsModule,
            pathModule
        });
        message = buildMediaMessage({
            mediaKey,
            mediaValue: { url: mediaPath },
            caption: payload.caption,
            mimetype
        });
    } else if (job.type === 'media_url') {
        if (!payload.url) {
            throw new Error('media_url payload.url is required');
        }
        const response = await axiosClient.get(payload.url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxContentLength: MEDIA_URL_LIMIT_BYTES,
            maxBodyLength: MEDIA_URL_LIMIT_BYTES
        });
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
