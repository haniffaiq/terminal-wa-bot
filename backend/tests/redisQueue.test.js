const assert = require('node:assert/strict');
const test = require('node:test');

const { buildConnectionOptions } = require('../services/redisQueue');

test('buildConnectionOptions maps a simple Redis URL', () => {
    const options = buildConnectionOptions('redis://redis:6379');

    assert.deepEqual(options, {
        host: 'redis',
        port: 6379
    });
    assert.equal(Object.hasOwn(options, 'password'), false);
    assert.equal(Object.hasOwn(options, 'db'), false);
    assert.equal(Object.hasOwn(options, 'tls'), false);
});

test('buildConnectionOptions preserves ACL username, decoded password, and db index', () => {
    assert.deepEqual(buildConnectionOptions('redis://user:p%40ss@example.com:6380/2'), {
        host: 'example.com',
        port: 6380,
        username: 'user',
        password: 'p@ss',
        db: 2
    });
});

test('buildConnectionOptions enables TLS for rediss URLs', () => {
    const options = buildConnectionOptions('rediss://:secret@secure.example.com:6381/4');

    assert.deepEqual(options, {
        host: 'secure.example.com',
        port: 6381,
        password: 'secret',
        db: 4,
        tls: {}
    });
    assert.ok(options.tls);
});

test('buildConnectionOptions rejects non-Redis URL protocols', () => {
    assert.throws(
        () => buildConnectionOptions('http://example.com'),
        /Redis URL/
    );
});
