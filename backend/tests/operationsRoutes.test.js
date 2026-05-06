const assert = require('node:assert/strict');
const test = require('node:test');

const operationsRoutes = require('../routes/operations');
const TENANT_ID = '3f65a22d-b1b8-44db-94c7-1f0c8db68c45';
const OTHER_TENANT_ID = '4f65a22d-b1b8-44db-94c7-1f0c8db68c46';

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

test('getActorId prefers auth userId before legacy fields', () => {
    assert.equal(operationsRoutes._getActorId({
        user: {
            userId: 'auth-user-id',
            id: 'legacy-id',
            username: 'operator'
        }
    }), 'auth-user-id');
    assert.equal(operationsRoutes._getActorId({ user: { id: 'legacy-id', username: 'operator' } }), 'legacy-id');
    assert.equal(operationsRoutes._getActorId({ user: { username: 'operator' } }), 'operator');
    assert.equal(operationsRoutes._getActorId({ user: {} }), null);
    assert.equal(operationsRoutes._getActorId({}), null);
});

test('getTenantScope filters regular users by token tenant and validates super-admin query tenant_id', () => {
    const tenantParams = ['existing'];
    assert.deepEqual(
        operationsRoutes._getTenantScope({
            user: { role: 'tenant_admin', tenantId: TENANT_ID },
            query: { tenant_id: OTHER_TENANT_ID }
        }, tenantParams),
        { clause: ' AND tenant_id = $2', params: ['existing', TENANT_ID], tenantId: TENANT_ID }
    );

    const superAllParams = [];
    assert.deepEqual(
        operationsRoutes._getTenantScope({
            user: { role: 'super_admin' },
            query: {}
        }, superAllParams),
        { clause: '', params: [], tenantId: null }
    );

    const superTenantParams = [];
    assert.deepEqual(
        operationsRoutes._getTenantScope({
            user: { role: 'super_admin' },
            query: { tenant_id: OTHER_TENANT_ID }
        }, superTenantParams, 'bh.tenant_id'),
        { clause: ' AND bh.tenant_id = $1', params: [OTHER_TENANT_ID], tenantId: OTHER_TENANT_ID }
    );

    assert.throws(
        () => operationsRoutes._getTenantScope({
            user: { role: 'super_admin' },
            query: { tenant_id: 'not-a-uuid' }
        }, []),
        /tenant_id must be a valid UUID/
    );
    assert.throws(
        () => operationsRoutes._getTenantScope({
            user: { role: 'super_admin' },
            query: { tenant_id: '' }
        }, []),
        /tenant_id must be a valid UUID/
    );
});

test('buildJobsQuery applies tenant-scoped filters with placeholders', () => {
    const req = {
        user: {
            role: 'tenant_admin',
            tenantId: TENANT_ID
        },
        query: {
            status: 'queued,retrying',
            source: 'api',
            target: '62812',
            bot: 'bot-a',
            tenant_id: OTHER_TENANT_ID,
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
        TENANT_ID,
        ['queued', 'retrying'],
        'api',
        '%62812%',
        'bot-a',
        '2026-05-01T00:00:00.000Z',
        '2026-05-06T23:59:59.999Z',
        25,
        10
    ]);
    assert.equal(sql.includes(OTHER_TENANT_ID), false);
});

test('buildJobsQuery honors tenant_id only for super_admin', () => {
    const built = operationsRoutes.__buildJobsQueryForTests({
        user: { role: 'super_admin' },
        query: {
            tenant_id: OTHER_TENANT_ID,
            limit: '999'
        }
    });

    const sql = normalizeSql(built.sql);
    assert.match(sql, /tenant_id = \$1/);
    assert.match(sql, /LIMIT \$2 OFFSET \$3/);
    assert.deepEqual(built.params, [OTHER_TENANT_ID, 200, 0]);
});

test('buildJobsQuery rejects invalid super-admin tenant_id and date filters', () => {
    assert.throws(
        () => operationsRoutes.__buildJobsQueryForTests({
            user: { role: 'super_admin' },
            query: { tenant_id: 'tenant-2' }
        }),
        /tenant_id must be a valid UUID/
    );

    assert.throws(
        () => operationsRoutes.__buildJobsQueryForTests({
            user: { role: 'tenant_admin', tenantId: TENANT_ID },
            query: { date_from: '2026-99-99' }
        }),
        /date_from must be a valid date/
    );

    assert.throws(
        () => operationsRoutes.__buildJobsQueryForTests({
            user: { role: 'tenant_admin', tenantId: TENANT_ID },
            query: { date_from: '2026-02-31' }
        }),
        /date_from must be a valid date/
    );
});

test('buildBotHealthQuery and buildOperationalEventsQuery use consistent super-admin tenant scope', () => {
    const botHealth = operationsRoutes._buildBotHealthQuery({
        user: { role: 'super_admin' },
        query: { tenant_id: OTHER_TENANT_ID, status: 'online,offline' }
    });
    assert.match(normalizeSql(botHealth.sql), /tenant_id = \$1/);
    assert.match(normalizeSql(botHealth.sql), /status = ANY\(\$2::varchar\[\]\)/);
    assert.deepEqual(botHealth.params, [OTHER_TENANT_ID, ['online', 'offline']]);

    const events = operationsRoutes._buildOperationalEventsQuery({
        user: { role: 'super_admin' },
        query: { tenant_id: OTHER_TENANT_ID, event_type: 'job_resolved', limit: '5' }
    });
    assert.match(normalizeSql(events.sql), /tenant_id = \$1/);
    assert.match(normalizeSql(events.sql), /event_type = \$2/);
    assert.match(normalizeSql(events.sql), /LIMIT \$3 OFFSET \$4/);
    assert.deepEqual(events.params, [OTHER_TENANT_ID, 'job_resolved', 5, 0]);
});

test('buildOpsSummaryQueries applies requested tenant_id to every summary query', () => {
    const queries = operationsRoutes._buildOpsSummaryQueries({
        user: { role: 'super_admin' },
        query: { tenant_id: OTHER_TENANT_ID }
    });

    assert.match(normalizeSql(queries.jobStatus.sql), /tenant_id = \$1/);
    assert.deepEqual(queries.jobStatus.params, [OTHER_TENANT_ID]);
    assert.match(normalizeSql(queries.sentToday.sql), /tenant_id = \$1/);
    assert.deepEqual(queries.sentToday.params, [OTHER_TENANT_ID]);
    assert.match(normalizeSql(queries.botHealth.sql), /tenant_id = \$1/);
    assert.deepEqual(queries.botHealth.params, [OTHER_TENANT_ID]);
    assert.match(normalizeSql(queries.stale.sql), /tenant_id = \$2/);
    assert.deepEqual(queries.stale.params, [120, OTHER_TENANT_ID]);
});

test('getReconnectTenantId validates super-admin reconnect tenant input', () => {
    assert.equal(operationsRoutes._getReconnectTenantId({
        user: { role: 'tenant_admin', tenantId: TENANT_ID },
        body: { tenant_id: 'not-a-uuid' },
        query: {}
    }), TENANT_ID);

    assert.equal(operationsRoutes._getReconnectTenantId({
        user: { role: 'super_admin' },
        body: { tenantId: OTHER_TENANT_ID },
        query: {}
    }), OTHER_TENANT_ID);

    assert.throws(
        () => operationsRoutes._getReconnectTenantId({ user: { role: 'super_admin' }, body: {}, query: {} }),
        /tenant_id is required for reconnect/
    );
    assert.throws(
        () => operationsRoutes._getReconnectTenantId({
            user: { role: 'super_admin' },
            body: {},
            query: { tenant_id: 'not-a-uuid' }
        }),
        /tenant_id must be a valid UUID/
    );
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
