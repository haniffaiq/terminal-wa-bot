const assert = require('node:assert/strict');
const test = require('node:test');

const {
    formatHeaderStamp,
    buildMessageHeader,
    applyHeaderToText,
    applyHeaderToMessage
} = require('../utils/messageHeader');

// 2026-07-12T06:13:45.123Z == 13:13:45.123 in Asia/Jakarta (UTC+7).
const INSTANT = new Date('2026-07-12T06:13:45.123Z');

test('stamp is 17 digits of YYYYMMDDHHMMSSmmm in Jakarta time', () => {
    const stamp = formatHeaderStamp(INSTANT);

    assert.equal(stamp, '20260712131345123');
    assert.equal(stamp.length, 17);
    assert.match(stamp, /^\d{17}$/);
});

test('stamp rolls the date over when Jakarta is already on the next day', () => {
    // 23:30 UTC on the 12th is 06:30 on the 13th in Jakarta.
    assert.equal(formatHeaderStamp(new Date('2026-07-12T23:30:00.000Z')).slice(0, 8), '20260713');
});

test('header is TENANT uppercased, separated from the stamp', () => {
    assert.equal(buildMessageHeader({ tenantName: 'petagid', date: INSTANT }), 'PETAGID - 20260712131345123');
});

test('no tenant name means no header rather than a broken one', () => {
    assert.equal(buildMessageHeader({ tenantName: null, date: INSTANT }), null);
    assert.equal(buildMessageHeader({ tenantName: '', date: INSTANT }), null);
});

test('two sends in the same second still differ, which is the whole point', () => {
    const a = buildMessageHeader({ tenantName: 'petagid', date: new Date('2026-07-12T06:13:45.001Z') });
    const b = buildMessageHeader({ tenantName: 'petagid', date: new Date('2026-07-12T06:13:45.002Z') });

    assert.notEqual(a, b);
});

test('header sits above the body, separated by a blank line', () => {
    assert.equal(applyHeaderToText('Halo', 'PETAGID - 1'), 'PETAGID - 1\n\nHalo');
});

test('an empty body leaves the header alone rather than trailing blank lines', () => {
    assert.equal(applyHeaderToText('', 'PETAGID - 1'), 'PETAGID - 1');
    assert.equal(applyHeaderToText(undefined, 'PETAGID - 1'), 'PETAGID - 1');
});

test('a null header passes the text through untouched', () => {
    assert.equal(applyHeaderToText('Halo', null), 'Halo');
});

test('text messages get the header on text', () => {
    assert.deepEqual(
        applyHeaderToMessage({ text: 'Halo' }, 'PETAGID - 1'),
        { text: 'PETAGID - 1\n\nHalo' }
    );
});

test('media messages get the header on caption, preserving the payload', () => {
    const buffer = Buffer.from('x');

    assert.deepEqual(
        applyHeaderToMessage({ image: buffer, mimetype: 'image/png', caption: 'Nota' }, 'PETAGID - 1'),
        { image: buffer, mimetype: 'image/png', caption: 'PETAGID - 1\n\nNota' }
    );
});

test('caption-less media grows one so it is stamped too', () => {
    const buffer = Buffer.from('x');

    assert.deepEqual(
        applyHeaderToMessage({ document: buffer, mimetype: 'application/pdf' }, 'PETAGID - 1'),
        { document: buffer, mimetype: 'application/pdf', caption: 'PETAGID - 1' }
    );
});

test('applying a header does not mutate the caller message', () => {
    const original = { text: 'Halo' };
    applyHeaderToMessage(original, 'PETAGID - 1');

    assert.deepEqual(original, { text: 'Halo' });
});
