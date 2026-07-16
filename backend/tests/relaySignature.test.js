const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const { buildRelayBody, signRelayBody } = require('../utils/relaySignature');

const VECTOR = {
    from: '6281234567890',
    text: 'PETAG-VERIFY:AbCdEf0123456789',
    messageId: '3EB0C767D26B8C3F1A2B',
    timestamp: 1752600000
};
const VECTOR_BODY = '{"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}';
const VECTOR_SECRET = 'test-secret-do-not-use-in-prod';
const VECTOR_SIG = 'a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e';

// This vector is published to petag.id in docs/petag-integration-brief.md.
// If it changes, their implementation breaks — update the brief too.
test('builds the documented body byte-for-byte', () => {
    assert.equal(buildRelayBody(VECTOR), VECTOR_BODY);
});

test('signs the documented test vector', () => {
    assert.equal(signRelayBody(VECTOR_SECRET, VECTOR_BODY), VECTOR_SIG);
});

test('field order is fixed: from, text, message_id, timestamp', () => {
    // Same values supplied in a different order must still serialize identically,
    // because the destination hashes raw bytes and key order changes the hash.
    const body = buildRelayBody({
        timestamp: 1752600000,
        messageId: '3EB0C767D26B8C3F1A2B',
        text: 'PETAG-VERIFY:AbCdEf0123456789',
        from: '6281234567890'
    });
    assert.equal(body, VECTOR_BODY);
});

test('the marker and blob are forwarded verbatim, untrimmed', () => {
    const body = buildRelayBody({ ...VECTOR, text: '  PETAG-VERIFY:xx  ' });
    assert.match(body, /"text":"  PETAG-VERIFY:xx  "/);
});

test('signature is lowercase hex of the exact bytes', () => {
    const sig = signRelayBody('k', 'some-body');
    assert.match(sig, /^[0-9a-f]{64}$/);
    assert.equal(sig, crypto.createHmac('sha256', 'k').update('some-body').digest('hex'));
});

test('a different key order produces a different signature (why we send the string)', () => {
    const reordered = '{"text":"PETAG-VERIFY:AbCdEf0123456789","from":"6281234567890","timestamp":1752600000,"message_id":"3EB0C767D26B8C3F1A2B"}';
    assert.notEqual(signRelayBody(VECTOR_SECRET, reordered), VECTOR_SIG);
});
