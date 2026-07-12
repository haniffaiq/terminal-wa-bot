const assert = require('node:assert/strict');
const test = require('node:test');

const { createBotProxyService } = require('../services/botProxyService');

test('returns the active proxy url for a bot', async () => {
    const svc = createBotProxyService({
        queryFn: async (sql, params) => {
            assert.match(sql, /FROM bot_proxies WHERE tenant_id = \$1 AND bot_id = \$2 AND is_active = TRUE/i);
            assert.deepEqual(params, ['t1', 'bot-a']);
            return { rows: [{ proxy_url: 'socks5://1.2.3.4:1080' }] };
        }
    });

    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 0), 'socks5://1.2.3.4:1080');
});

test('caches within the ttl, refetches after', async () => {
    let calls = 0;
    const svc = createBotProxyService({
        queryFn: async () => { calls += 1; return { rows: [{ proxy_url: `p-${calls}` }] }; },
        ttlMs: 1000
    });

    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 0), 'p-1');
    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 500), 'p-1');
    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 1001), 'p-2');
    assert.equal(calls, 2);
});

test('a bot with no proxy row resolves to null (direct connect)', async () => {
    const svc = createBotProxyService({ queryFn: async () => ({ rows: [] }) });
    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 0), null);
});

test('a DB error serves the last cached value rather than dropping the proxy', async () => {
    let calls = 0;
    const svc = createBotProxyService({
        queryFn: async () => {
            calls += 1;
            if (calls === 1) return { rows: [{ proxy_url: 'socks5://good' }] };
            throw new Error('table missing');
        },
        ttlMs: 100
    });

    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 0), 'socks5://good');
    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 500), 'socks5://good');
});

test('missing ids resolve to null without a query', async () => {
    let called = false;
    const svc = createBotProxyService({ queryFn: async () => { called = true; return { rows: [] }; } });

    assert.equal(await svc.getProxyUrl(null, 'bot-a', 0), null);
    assert.equal(await svc.getProxyUrl('t1', null, 0), null);
    assert.equal(called, false);
});

test('invalidate forces a refetch', async () => {
    let calls = 0;
    const svc = createBotProxyService({
        queryFn: async () => { calls += 1; return { rows: [{ proxy_url: `p-${calls}` }] }; },
        ttlMs: 100000
    });

    await svc.getProxyUrl('t1', 'bot-a', 0);
    svc.invalidate('t1', 'bot-a');
    assert.equal(await svc.getProxyUrl('t1', 'bot-a', 1), 'p-2');
});
