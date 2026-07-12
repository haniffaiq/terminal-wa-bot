const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantNameCache } = require('../services/tenantNameCache');

test('resolves a tenant name and then serves it from cache', async () => {
    let calls = 0;
    const cache = createTenantNameCache({
        queryFn: async () => {
            calls += 1;
            return { rows: [{ name: 'petagid' }] };
        },
        ttlMs: 1000
    });

    assert.equal(await cache.getTenantName('tenant-1', 0), 'petagid');
    assert.equal(await cache.getTenantName('tenant-1', 500), 'petagid');
    assert.equal(calls, 1);
});

test('refetches once the ttl lapses', async () => {
    let calls = 0;
    const cache = createTenantNameCache({
        queryFn: async () => {
            calls += 1;
            return { rows: [{ name: `name-${calls}` }] };
        },
        ttlMs: 1000
    });

    assert.equal(await cache.getTenantName('tenant-1', 0), 'name-1');
    assert.equal(await cache.getTenantName('tenant-1', 1001), 'name-2');
    assert.equal(calls, 2);
});

test('a DB blip serves the stale name instead of dropping the header', async () => {
    let calls = 0;
    const cache = createTenantNameCache({
        queryFn: async () => {
            calls += 1;
            if (calls === 1) return { rows: [{ name: 'petagid' }] };
            throw new Error('db down');
        },
        ttlMs: 1000
    });

    assert.equal(await cache.getTenantName('tenant-1', 0), 'petagid');
    assert.equal(await cache.getTenantName('tenant-1', 2000), 'petagid');
});

test('an unknown tenant resolves to null rather than throwing', async () => {
    const cache = createTenantNameCache({ queryFn: async () => ({ rows: [] }) });

    assert.equal(await cache.getTenantName('nope', 0), null);
    assert.equal(await cache.getTenantName(null, 0), null);
});

test('invalidate forces the next lookup to hit the DB', async () => {
    let calls = 0;
    const cache = createTenantNameCache({
        queryFn: async () => {
            calls += 1;
            return { rows: [{ name: `name-${calls}` }] };
        },
        ttlMs: 100000
    });

    await cache.getTenantName('tenant-1', 0);
    cache.invalidate('tenant-1');
    assert.equal(await cache.getTenantName('tenant-1', 1), 'name-2');
});
