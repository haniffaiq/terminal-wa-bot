const assert = require('node:assert/strict');
const test = require('node:test');

const operationsRoutes = require('../routes/operations');

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
