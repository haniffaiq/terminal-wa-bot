const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { sendJob } = require('../services/messageSender');

function createSock() {
    return {
        calls: [],
        async sendMessage(targetId, message) {
            this.calls.push({ targetId, message });
            return { key: { id: 'message-1' } };
        }
    };
}

function createFs({ exists = true } = {}) {
    return {
        existsSync() {
            return exists;
        }
    };
}

test('sendJob sends text payload with transaction id prefix', async () => {
    const sock = createSock();

    const result = await sendJob({
        sock,
        job: {
            type: 'text',
            target_id: 'group-1',
            payload: {
                transactionId: 'TRX-123',
                message: 'Payment received'
            }
        }
    });

    assert.equal(typeof result.responseTimeSeconds, 'number');
    assert.equal(sock.calls.length, 1);
    assert.deepEqual(sock.calls[0], {
        targetId: 'group-1',
        message: { text: 'TRX-123\n\n\nPayment received' }
    });
});

test('sendJob sends uploaded image media based on mimetype', async () => {
    const sock = createSock();
    const filePath = 'uploads/photo.jpg';

    await sendJob({
        sock,
        fsModule: createFs(),
        job: {
            type: 'media_upload',
            target_id: 'group-1',
            payload: {
                filePath,
                mimetype: 'image/jpeg',
                caption: 'Receipt'
            }
        }
    });

    assert.deepEqual(sock.calls[0], {
        targetId: 'group-1',
        message: {
            image: { url: path.resolve(filePath) },
            caption: 'Receipt',
            mimetype: 'image/jpeg'
        }
    });
});

test('sendJob sends uploaded document media based on mimetype', async () => {
    const sock = createSock();
    const filePath = 'uploads/report.pdf';

    await sendJob({
        sock,
        fsModule: createFs(),
        job: {
            type: 'media_upload',
            target_id: 'group-1',
            payload: {
                filePath,
                mimetype: 'application/pdf',
                caption: 'Report'
            }
        }
    });

    assert.deepEqual(sock.calls[0], {
        targetId: 'group-1',
        message: {
            document: { url: path.resolve(filePath) },
            caption: 'Report',
            mimetype: 'application/pdf'
        }
    });
});

test('sendJob sends uploaded video media under upload root', async () => {
    const sock = createSock();
    const filePath = '/app/uploads/clips/demo.mp4';

    await sendJob({
        sock,
        fsModule: createFs(),
        uploadRoot: '/app/uploads',
        job: {
            type: 'media_upload',
            target_id: 'group-1',
            payload: {
                filePath,
                mimetype: 'video/mp4',
                caption: 'Demo'
            }
        }
    });

    assert.deepEqual(sock.calls[0], {
        targetId: 'group-1',
        message: {
            video: { url: path.resolve(filePath) },
            caption: 'Demo',
            mimetype: 'video/mp4'
        }
    });
});

test('sendJob sends uploaded audio media under upload root', async () => {
    const sock = createSock();
    const filePath = path.join(process.cwd(), 'uploads/voice.ogg');

    await sendJob({
        sock,
        fsModule: createFs(),
        uploadRoot: path.join(process.cwd(), 'uploads'),
        job: {
            type: 'media_upload',
            target_id: 'group-1',
            payload: {
                filePath,
                mimetype: 'audio/ogg; codecs=opus'
            }
        }
    });

    assert.deepEqual(sock.calls[0], {
        targetId: 'group-1',
        message: {
            audio: { url: path.resolve(filePath) },
            mimetype: 'audio/ogg; codecs=opus'
        }
    });
});

test('sendJob rejects uploaded media outside configured upload root', async () => {
    const sock = createSock();

    await assert.rejects(
        () => sendJob({
            sock,
            fsModule: createFs(),
            uploadRoot: '/app/uploads',
            job: {
                type: 'media_upload',
                target_id: 'group-1',
                payload: {
                    filePath: '/app/secrets/token.txt',
                    mimetype: 'text/plain'
                }
            }
        }),
        /outside upload root/
    );
    assert.deepEqual(sock.calls, []);
});

test('sendJob rejects uploaded media path traversal outside upload root', async () => {
    const sock = createSock();

    await assert.rejects(
        () => sendJob({
            sock,
            fsModule: createFs(),
            uploadRoot: '/app/uploads',
            job: {
                type: 'media_upload',
                target_id: 'group-1',
                payload: {
                    filePath: '../secrets/token.txt',
                    mimetype: 'text/plain'
                }
            }
        }),
        /outside upload root/
    );
    assert.deepEqual(sock.calls, []);
});

test('sendJob rejects uploaded media when file is missing', async () => {
    const sock = createSock();

    await assert.rejects(
        () => sendJob({
            sock,
            fsModule: createFs({ exists: false }),
            uploadRoot: '/app/uploads',
            job: {
                type: 'media_upload',
                target_id: 'group-1',
                payload: {
                    filePath: '/app/uploads/missing.pdf',
                    mimetype: 'application/pdf'
                }
            }
        }),
        /not found/
    );
    assert.deepEqual(sock.calls, []);
});

test('sendJob sends URL media using downloaded buffer and content type', async () => {
    const sock = createSock();
    const mediaBuffer = Buffer.from('video-bytes');
    const axiosClient = {
        calls: [],
        async get(url, options) {
            this.calls.push({ url, options });
            return {
                data: mediaBuffer,
                headers: { 'content-type': 'video/mp4; charset=utf-8' }
            };
        }
    };

    await sendJob({
        sock,
        axiosClient,
        job: {
            type: 'media_url',
            target_id: 'group-1',
            payload: {
                url: 'https://example.test/video.mp4',
                caption: 'Demo'
            }
        }
    });

    assert.deepEqual(axiosClient.calls, [{
        url: 'https://example.test/video.mp4',
        options: {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxContentLength: 25 * 1024 * 1024,
            maxBodyLength: 25 * 1024 * 1024
        }
    }]);
    assert.deepEqual(sock.calls[0], {
        targetId: 'group-1',
        message: {
            video: mediaBuffer,
            caption: 'Demo',
            mimetype: 'video/mp4'
        }
    });
});
