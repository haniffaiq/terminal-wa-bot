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
