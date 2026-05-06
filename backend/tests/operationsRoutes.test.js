const assert = require('node:assert/strict');
const test = require('node:test');

const operationsRoutes = require('../routes/operations');

function normalizeSql(sql) {
    return sql.replace(/\s+/g, ' ').trim();
}

test('isValidUuid accepts canonical UUIDs and rejects invalid values', () => {
    assert.equal(operationsRoutes.__isValidUuidForTests('3f65a22d-b1b8-44db-94c7-1f0c8db68c45'), true);
    assert.equal(operationsRoutes.__isValidUuidForTests('3F65A22D-B1B8-44DB-94C7-1F0C8DB68C45'), true);
    assert.equal(operationsRoutes.__isValidUuidForTests('3f65a22d-b1b8-14db-94c7-1f0c8db68c45'), true);
    assert.equal(operationsRoutes.__isValidUuidForTests('not-a-uuid'), false);
    assert.equal(operationsRoutes.__isValidUuidForTests('3f65a22d-b1b8-44db-94c7-1f0c8db68c4'), false);
    assert.equal(operationsRoutes.__isValidUuidForTests('3f65a22d-b1b8-44db-94c7-1f0c8db68c45-extra'), false);
    assert.equal(operationsRoutes.__isValidUuidForTests(''), false);
    assert.equal(operationsRoutes.__isValidUuidForTests(null), false);
});

test('validateUuidList rejects missing, empty, and invalid id arrays', () => {
    assert.deepEqual(operationsRoutes.__validateUuidListForTests(undefined, 'job_ids'), {
        ok: false,
        error: 'job_ids must be a non-empty array'
    });
    assert.deepEqual(operationsRoutes.__validateUuidListForTests([], 'job_ids'), {
        ok: false,
        error: 'job_ids must be a non-empty array'
    });
    assert.deepEqual(operationsRoutes.__validateUuidListForTests([
        '3f65a22d-b1b8-44db-94c7-1f0c8db68c45',
        'not-a-uuid'
    ], 'job_ids'), {
        ok: false,
        error: 'job_ids contains invalid UUID values'
    });
    assert.deepEqual(operationsRoutes.__validateUuidListForTests([
        '3f65a22d-b1b8-44db-94c7-1f0c8db68c45'
    ], 'job_ids'), {
        ok: true
    });
});

test('buildJobsQuery applies tenant-scoped filters with placeholders', () => {
    const req = {
        user: {
            role: 'tenant_admin',
            tenantId: 'tenant-1'
        },
        query: {
            status: 'queued,retrying',
            source: 'api',
            target: '62812',
            bot: 'bot-a',
            tenant_id: 'other-tenant',
            date_from: '2026-05-01T00:00:00.000Z',
            date_to: '2026-05-06T23:59:59.999Z',
            limit: '25',
            offset: '10'
        }
    };

    const built = operationsRoutes.__buildJobsQueryForTests(req);
    const sql = normalizeSql(built.sql);

    assert.match(sql, /tenant_id = \$1/);
    assert.match(sql, /status = ANY\(\$2::varchar\[\]\)/);
    assert.match(sql, /source = \$3/);
    assert.match(sql, /target_id ILIKE \$4/);
    assert.match(sql, /selected_bot_id = \$5/);
    assert.match(sql, /created_at >= \$6/);
    assert.match(sql, /created_at <= \$7/);
    assert.match(sql, /LIMIT \$8 OFFSET \$9/);
    assert.deepEqual(built.params, [
        'tenant-1',
        ['queued', 'retrying'],
        'api',
        '%62812%',
        'bot-a',
        '2026-05-01T00:00:00.000Z',
        '2026-05-06T23:59:59.999Z',
        25,
        10
    ]);
    assert.equal(sql.includes('other-tenant'), false);
});

test('buildJobsQuery honors tenant_id only for super_admin', () => {
    const built = operationsRoutes.__buildJobsQueryForTests({
        user: { role: 'super_admin' },
        query: {
            tenant_id: 'tenant-2',
            limit: '999'
        }
    });

    const sql = normalizeSql(built.sql);
    assert.match(sql, /tenant_id = \$1/);
    assert.match(sql, /LIMIT \$2 OFFSET \$3/);
    assert.deepEqual(built.params, ['tenant-2', 200, 0]);
});

test('buildOpsSummaryResponse returns dashboard count shape', () => {
    const summary = operationsRoutes.__buildOpsSummaryResponseForTests({
        jobRows: [
            { status: 'queued', count: 4 },
            { status: 'retrying', count: '2' },
            { status: 'failed', count: 3 },
            { status: 'sent_today', count: 8 },
            { status: 'resolved', count: 1 },
            { status: 'ignored', count: 5 }
        ],
        botRows: [
            { status: 'online', count: 6 },
            { status: 'offline', count: 2 },
            { status: 'cooldown', count: 1 }
        ],
        staleCount: 2,
        generatedAt: '2026-05-06T09:00:00.000Z'
    });

    assert.deepEqual(summary, {
        jobs: {
            queued: 4,
            sending: 0,
            retrying: 2,
            failed: 3,
            sent_today: 8,
            resolved: 1,
            ignored: 5,
            queue_depth: 6
        },
        bots: {
            online: 6,
            offline: 2,
            reconnecting: 0,
            cooldown: 1,
            qr_required: 0,
            unknown: 0,
            total: 9,
            stale: 2
        },
        generated_at: '2026-05-06T09:00:00.000Z'
    });
});
