const assert = require('node:assert/strict');
const test = require('node:test');

const adminBot = require('../bots/adminBot');

test('extractMessageText reads command text from common WhatsApp wrappers', () => {
    assert.equal(
        adminBot.__extractMessageTextForTests({
            message: {
                ephemeralMessage: {
                    message: {
                        extendedTextMessage: { text: '  !owner  ' }
                    }
                }
            }
        }),
        '!owner'
    );

    assert.equal(
        adminBot.__extractMessageTextForTests({
            message: {
                imageMessage: { caption: '!owner' }
            }
        }),
        '!owner'
    );
});

test('admin socket generation tracker marks older sockets stale after replacement', () => {
    const tracker = adminBot.__createAdminSocketGenerationTrackerForTests();
    const first = tracker.next('tenant-1');
    assert.equal(tracker.isCurrent('tenant-1', first), true);

    const second = tracker.next('tenant-1');
    assert.equal(tracker.isCurrent('tenant-1', first), false);
    assert.equal(tracker.isCurrent('tenant-1', second), true);
});

test('callApi rejects when command API times out', async () => {
    const fakeRequest = {
        on() {
            return this;
        },
        setTimeout(ms, callback) {
            assert.equal(ms, 5);
            callback();
            return this;
        },
        destroy(error) {
            this.destroyedWith = error;
        }
    };

    const fakeHttp = {
        get(url, callback) {
            assert.equal(url, 'http://example.local?keyword=abc&type=PMT');
            assert.equal(typeof callback, 'function');
            return fakeRequest;
        }
    };

    await assert.rejects(
        () => adminBot.__callApiForTests('abc', 'PMT', {
            httpClient: fakeHttp,
            baseUrl: 'http://example.local',
            timeoutMs: 5
        }),
        /timed out/
    );
});
