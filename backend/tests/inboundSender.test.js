const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveSenderPhone } = require('../utils/inboundSender');

test('resolves the phone number from a plain DM jid', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '6281234567890@s.whatsapp.net' }), '6281234567890');
});

test('prefers senderPn when remoteJid is a lid', () => {
    assert.equal(resolveSenderPhone({
        remoteJid: '99887766554433@lid',
        senderPn: '6281234567890@s.whatsapp.net'
    }), '6281234567890');
});

test('a lid-only sender resolves to null so the caller fails closed', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '99887766554433@lid' }), null);
});

test('accepts the legacy c.us server', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '6281234567890@c.us' }), '6281234567890');
});

test('a group jid resolves to null', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '120363419686014131@g.us' }), null);
});

test('a device-suffixed jid resolves to the bare number', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '6281234567890:12@s.whatsapp.net' }), '6281234567890');
});

test('missing or empty keys resolve to null', () => {
    assert.equal(resolveSenderPhone({}), null);
    assert.equal(resolveSenderPhone(), null);
    assert.equal(resolveSenderPhone({ remoteJid: '' }), null);
});
