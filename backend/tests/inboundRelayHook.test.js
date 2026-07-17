const assert = require('node:assert/strict');
const test = require('node:test');

const { maybeRelayInbound } = require('../bots/commandHandler');

const TENANT = { id: 't1', brand_name: 'ZYRON' };
const RELAY = {
    marker: 'PETAG-VERIFY:',
    destination_url: 'https://api.petag.id/webhooks/zyron',
    secret: 's3cr3t',
    reply_text: null
};

function dmMessage(text, overrides = {}) {
    return {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'MSG1', ...overrides.key },
        messageTimestamp: 1752600000
    };
}

function deps(over = {}) {
    return {
        getRelay: async () => RELAY,
        forward: async () => ({ ok: true, status: 200 }),
        logDroppedSender: async () => {},
        ...over
    };
}

test('forwards a marker message from a DM', async () => {
    const forwarded = [];
    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: { sendMessage: async () => {} },
        deps: deps({ forward: async (a) => { forwarded.push(a); return { ok: true, status: 200 }; } })
    });

    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].tenantId, 't1');
    assert.equal(forwarded[0].from, '6281234567890');
    assert.equal(forwarded[0].text, 'PETAG-VERIFY:blob123');
    assert.equal(forwarded[0].messageId, 'MSG1');
    assert.equal(forwarded[0].timestamp, 1752600000);
});

test('a group message is never relayed, and never reaches the config lookup', async () => {
    let configLooked = false;
    let forwarded = false;
    await maybeRelayInbound({
        message: dmMessage(null, { key: { remoteJid: '120363419686014131@g.us' } }),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({
            getRelay: async () => { configLooked = true; return RELAY; },
            forward: async () => { forwarded = true; return { ok: true }; }
        })
    });

    assert.equal(forwarded, false);
    assert.equal(configLooked, false, 'group chatter must not cost a config lookup');
});

test('a non-marker DM is not relayed', async () => {
    let forwarded = false;
    await maybeRelayInbound({
        message: dmMessage(),
        text: 'hello there',
        tenant: TENANT,
        sock: {},
        deps: deps({ forward: async () => { forwarded = true; return { ok: true }; } })
    });

    assert.equal(forwarded, false);
});

test('a tenant with no relay configured is a no-op', async () => {
    let forwarded = false;
    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({ getRelay: async () => null, forward: async () => { forwarded = true; return { ok: true }; } })
    });

    assert.equal(forwarded, false);
});

test('a LID-only sender is dropped and logged, never forwarded', async () => {
    let forwarded = false;
    const dropped = [];
    await maybeRelayInbound({
        message: dmMessage(null, { key: { remoteJid: '99887766554433@lid', id: 'MSG9' } }),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({
            forward: async () => { forwarded = true; return { ok: true }; },
            logDroppedSender: async (a) => { dropped.push(a); }
        })
    });

    assert.equal(forwarded, false, 'a LID must never be sent as `from`');
    assert.deepEqual(dropped, [{ tenantId: 't1', messageId: 'MSG9' }]);
});

test('senderPn rescues a LID-addressed message', async () => {
    const forwarded = [];
    await maybeRelayInbound({
        message: dmMessage(null, {
            key: { remoteJid: '99887766554433@lid', senderPn: '6281234567890@s.whatsapp.net', id: 'MSG2' }
        }),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({ forward: async (a) => { forwarded.push(a); return { ok: true, status: 200 }; } })
    });

    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].from, '6281234567890');
});

test('the confirmation reply is sent only after a 200', async () => {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); } };

    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({ getRelay: async () => ({ ...RELAY, reply_text: 'Verified' }) })
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, '6281234567890@s.whatsapp.net');
    assert.equal(sent[0].content.text, 'Verified');
});

test('no confirmation reply when the forward failed', async () => {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); } };

    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({
            getRelay: async () => ({ ...RELAY, reply_text: 'Verified' }),
            forward: async () => ({ ok: false, status: 500 })
        })
    });

    assert.equal(sent.length, 0);
});

test('no confirmation reply when reply_text is empty', async () => {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); } };

    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({ getRelay: async () => ({ ...RELAY, reply_text: '' }) })
    });

    assert.equal(sent.length, 0);
});

test('a reply failure never surfaces — the relay already succeeded', async () => {
    const sock = { sendMessage: async () => { throw new Error('socket closed'); } };

    await assert.doesNotReject(() => maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({ getRelay: async () => ({ ...RELAY, reply_text: 'Verified' }) })
    }));
});

test('a missing messageTimestamp falls back to now', async () => {
    const forwarded = [];
    const message = dmMessage();
    delete message.messageTimestamp;

    await maybeRelayInbound({
        message,
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({ forward: async (a) => { forwarded.push(a); return { ok: true, status: 200 }; } })
    });

    assert.ok(Number.isFinite(forwarded[0].timestamp));
    assert.ok(forwarded[0].timestamp > 1700000000);
});
