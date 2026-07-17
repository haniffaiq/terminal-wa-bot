const assert = require('node:assert/strict');
const test = require('node:test');

const commandHandler = require('../bots/commandHandler');

test('claimMessage dedups the same message id and returns true only once', () => {
    commandHandler.__resetDedupForTests();
    assert.equal(commandHandler.__claimMessageForTests('t1', 'MSG-A'), true);
    assert.equal(commandHandler.__claimMessageForTests('t1', 'MSG-A'), false);
    assert.equal(commandHandler.__claimMessageForTests('t1', 'MSG-B'), true);
    // different tenant, same id is independent
    assert.equal(commandHandler.__claimMessageForTests('t2', 'MSG-A'), true);
});

test('claimMessage rejects empty tenant or id', () => {
    commandHandler.__resetDedupForTests();
    assert.equal(commandHandler.__claimMessageForTests('t1', ''), false);
    assert.equal(commandHandler.__claimMessageForTests('', 'MSG-A'), false);
});

test('claimMessage evicts oldest id past the FIFO cap', () => {
    commandHandler.__resetDedupForTests();
    const cap = commandHandler.__DEDUP_CAP;
    // claim the cap + 1 ids; the very first should be evicted and re-claimable
    for (let i = 0; i < cap; i++) {
        assert.equal(commandHandler.__claimMessageForTests('t1', `ID-${i}`), true);
    }
    assert.equal(commandHandler.__claimMessageForTests('t1', 'ID-overflow'), true); // evicts ID-0
    assert.equal(commandHandler.__claimMessageForTests('t1', 'ID-1'), false);       // still remembered
    assert.equal(commandHandler.__claimMessageForTests('t1', 'ID-0'), true);        // was evicted, re-claimable
});

test('selectResponder uses round-robin for groups and the claiming sock otherwise', () => {
    const claimingSock = { id: 'claiming' };
    const rrSock = { id: 'roundrobin' };
    const deps = { getNextBotForGroup: () => rrSock };

    // group target -> round-robin bot
    assert.equal(
        commandHandler.__selectResponderForTests('123@g.us', 't1', claimingSock, deps),
        rrSock
    );
    // personal / DM target -> claiming sock
    assert.equal(
        commandHandler.__selectResponderForTests('628@c.us', 't1', claimingSock, deps),
        claimingSock
    );
    // group but no live bot -> falls back to claiming sock
    assert.equal(
        commandHandler.__selectResponderForTests('123@g.us', 't1', claimingSock, { getNextBotForGroup: () => null }),
        claimingSock
    );
});

test('extractMessageText reads command text from common WhatsApp wrappers', () => {
    assert.equal(
        commandHandler.__extractMessageTextForTests({
            message: { ephemeralMessage: { message: { extendedTextMessage: { text: '  !owner  ' } } } }
        }),
        '!owner'
    );
    assert.equal(
        commandHandler.__extractMessageTextForTests({ message: { imageMessage: { caption: '!owner' } } }),
        '!owner'
    );
});

test('handleCustomCommand substitutes template variables and sends via the given sock', async () => {
    const calls = [];
    const fakeQuery = async (sql, params) => {
        if (/FROM custom_commands/i.test(sql)) {
            return { rows: [{ response_template: 'Hi {brand}, group {group_name}, bots {bot_count}' }] };
        }
        if (/FROM bot_status/i.test(sql)) {
            return { rows: [{ online: 2 }] };
        }
        return { rows: [] };
    };
    const sock = {
        groupMetadata: async () => ({ subject: 'Sales', participants: [{}, {}, {}] }),
        sendMessage: async (chatId, payload) => { calls.push({ chatId, payload }); }
    };
    const handled = await commandHandler.__handleCustomCommandForTests(
        sock,
        '123@g.us',
        '!promo',
        { id: 't1', brand_name: 'ACME' },
        { key: { remoteJid: '123@g.us', participant: '628111@s.whatsapp.net' } },
        fakeQuery
    );
    assert.equal(handled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chatId, '123@g.us');
    assert.equal(calls[0].payload.text, 'Hi ACME, group Sales, bots 2');
});

// ============================================================
// setupCommands: dispatch-level tests against the real
// `messages.upsert` listener (not the extracted helpers above).
// ============================================================
function fakeSock(overrides = {}) {
    let handler;
    return {
        ev: { on: (event, fn) => { if (event === 'messages.upsert') handler = fn; } },
        get handler() { return handler; },
        sendMessage: async () => {},
        ...overrides
    };
}

// m.type is NOT a staleness signal. baileys sets 'append' for the offline
// queue — messages sent while this bot was disconnected, delivered on
// reconnect (Socket/messages-recv.js:699). Those are new messages a user is
// waiting on. An earlier version of this handler dropped them; these two tests
// exist so it never happens again.
function relayDeps(forwarded, replyText = null) {
    return {
        getRelay: async () => ({
            marker: 'PETAG-VERIFY:',
            destination_url: 'https://api.petag.id/webhooks/zyron',
            secret: 's3cr3t',
            reply_text: replyText
        }),
        forward: async (a) => { forwarded.push(a); return { ok: true, status: 200 }; }
    };
}

test('an offline-queue delivery (type: "append") still relays — it is a new message, not a replay', async () => {
    commandHandler.__resetDedupForTests();
    const forwarded = [];
    const sock = fakeSock();
    const tenant = { id: 'offline-tenant', brand_name: 'ACME' };

    commandHandler.setupCommands(sock, 'bot1', tenant, relayDeps(forwarded));

    const message = {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'OFFLINE-MSG', fromMe: false },
        message: { conversation: 'PETAG-VERIFY:blob123' },
        messageTimestamp: 1752600000
    };

    // Sent while the bot was down; WhatsApp delivers it on reconnect.
    await sock.handler({ messages: [message], type: 'append' });

    assert.equal(forwarded.length, 1, 'a verification sent during a disconnect must still reach the destination');
});

test('an offline-queue delivery (type: "append") still runs a "!" command', async () => {
    commandHandler.__resetDedupForTests();
    const sent = [];
    const sock = fakeSock({ sendMessage: async (chatId, payload) => { sent.push({ chatId, payload }); } });
    const tenant = { id: 'offline-tenant-2', brand_name: 'ACME' };

    commandHandler.setupCommands(sock, 'bot1', tenant, {});

    const message = {
        key: { remoteJid: '123@g.us', id: 'OFFLINE-CMD', fromMe: false },
        message: { conversation: '!groupid' }
    };

    await sock.handler({ messages: [message], type: 'append' });

    assert.equal(sent.length, 1, 'a command sent during a disconnect must still run');
});

test('a live upsert (type: "notify") relays normally', async () => {
    commandHandler.__resetDedupForTests();
    const forwarded = [];
    const sock = fakeSock();
    const tenant = { id: 'live-tenant', brand_name: 'ACME' };

    commandHandler.setupCommands(sock, 'bot1', tenant, relayDeps(forwarded));

    const message = {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'NEW-MSG', fromMe: false },
        message: { conversation: 'PETAG-VERIFY:blob123' },
        messageTimestamp: 1752600000
    };

    await sock.handler({ messages: [message], type: 'notify' });

    assert.equal(forwarded.length, 1);
});

test('two concurrent messages.upsert events carrying the same group command id are handled exactly once', async () => {
    // Every member-bot in a group receives the same message with the same
    // message.key.id, and exactly one must answer. This pins that behavior.
    //
    // It does NOT pin the "claim before any await" ordering, despite what
    // that comment in setupCommands implies. claimMessage is synchronous and
    // JS is single-threaded, so its check-and-set is atomic on resume: with an
    // await above it, both handlers would yield, then the first to resume
    // claims and the second finds the id taken. Still exactly one. Verified by
    // injecting `await new Promise(r => setImmediate(r))` above the claim —
    // this test still passed.
    //
    // What the ordering actually buys is avoided work: claiming early means
    // one bot does the async work per group message instead of all of them.
    // That is a cost property, not a correctness one, and it is not asserted
    // here.
    commandHandler.__resetDedupForTests();
    const sent = [];
    const sock = fakeSock({ sendMessage: async (chatId, payload) => { sent.push({ chatId, payload }); } });
    const tenant = { id: 'race-tenant', brand_name: 'ACME' };

    commandHandler.setupCommands(sock, 'bot1', tenant, {});

    const message = {
        key: { remoteJid: '120363419686014131@g.us', id: 'DUP-GROUP-MSG', fromMe: false },
        message: { conversation: '!groupid' }
    };

    // Two member-bots receiving the same group message "at once".
    await Promise.all([
        sock.handler({ messages: [message] }),
        sock.handler({ messages: [message] })
    ]);

    assert.equal(sent.length, 1, 'exactly one bot must answer a duplicate group command');
});

test('handleCustomCommand returns false when command is not defined', async () => {
    const fakeQuery = async () => ({ rows: [] });
    const handled = await commandHandler.__handleCustomCommandForTests(
        { sendMessage: async () => {} },
        '123@g.us',
        '!nope',
        { id: 't1', brand_name: 'ACME' },
        { key: { remoteJid: '123@g.us' } },
        fakeQuery
    );
    assert.equal(handled, false);
});
