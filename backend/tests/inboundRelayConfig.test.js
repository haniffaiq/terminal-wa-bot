const assert = require('node:assert/strict');
const test = require('node:test');

const { createInboundRelayConfig } = require('../services/inboundRelayConfig');

const ROW = {
    marker: 'PETAG-VERIFY:',
    destination_url: 'https://api.petag.id/webhooks/zyron',
    secret: 's3cr3t',
    reply_text: null
};

test('returns the active relay config for a tenant', async () => {
    const svc = createInboundRelayConfig({
        queryFn: async (sql, params) => {
            assert.match(sql, /FROM inbound_relays WHERE tenant_id = \$1 AND is_active = TRUE/i);
            assert.deepEqual(params, ['t1']);
            return { rows: [ROW] };
        }
    });

    assert.deepEqual(await svc.getRelay('t1', 0), ROW);
});

test('caches within the ttl, refetches after', async () => {
    let calls = 0;
    const svc = createInboundRelayConfig({
        queryFn: async () => { calls += 1; return { rows: [{ ...ROW, marker: `M${calls}` }] }; },
        ttlMs: 1000
    });

    assert.equal((await svc.getRelay('t1', 0)).marker, 'M1');
    assert.equal((await svc.getRelay('t1', 500)).marker, 'M1');
    assert.equal((await svc.getRelay('t1', 1001)).marker, 'M2');
    assert.equal(calls, 2);
});

test('a tenant with no relay row resolves to null', async () => {
    const svc = createInboundRelayConfig({ queryFn: async () => ({ rows: [] }) });
    assert.equal(await svc.getRelay('t1', 0), null);
});

test('a null result is cached too, so chatter does not hammer the DB', async () => {
    let calls = 0;
    const svc = createInboundRelayConfig({
        queryFn: async () => { calls += 1; return { rows: [] }; },
        ttlMs: 1000
    });

    await svc.getRelay('t1', 0);
    await svc.getRelay('t1', 10);
    await svc.getRelay('t1', 20);
    assert.equal(calls, 1);
});

test('a DB error serves the last cached config rather than dropping relays', async () => {
    let calls = 0;
    const svc = createInboundRelayConfig({
        queryFn: async () => {
            calls += 1;
            if (calls === 1) return { rows: [ROW] };
            throw new Error('table missing');
        },
        ttlMs: 100
    });

    assert.deepEqual(await svc.getRelay('t1', 0), ROW);
    assert.deepEqual(await svc.getRelay('t1', 500), ROW);
});

test('a DB error with no cache resolves to null without throwing', async () => {
    const svc = createInboundRelayConfig({ queryFn: async () => { throw new Error('down'); } });
    assert.equal(await svc.getRelay('t1', 0), null);
});

test('a missing tenant id resolves to null without a query', async () => {
    let called = false;
    const svc = createInboundRelayConfig({ queryFn: async () => { called = true; return { rows: [] }; } });

    assert.equal(await svc.getRelay(null, 0), null);
    assert.equal(called, false);
});

test('invalidate forces a refetch', async () => {
    let calls = 0;
    const svc = createInboundRelayConfig({
        queryFn: async () => { calls += 1; return { rows: [{ ...ROW, marker: `M${calls}` }] }; },
        ttlMs: 100000
    });

    await svc.getRelay('t1', 0);
    svc.invalidate('t1');
    assert.equal((await svc.getRelay('t1', 1)).marker, 'M2');
});
