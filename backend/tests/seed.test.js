const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function loadSeedWithMocks({ queryFn, hashPasswordFn }) {
    const seedPath = require.resolve('../utils/seed');
    const dbPath = path.resolve(__dirname, '../utils/db.js');
    const authPath = path.resolve(__dirname, '../utils/auth.js');
    const originalLoad = Module._load;

    delete require.cache[seedPath];

    Module._load = function loadWithMocks(request, parent, isMain) {
        const resolvedRequest = Module._resolveFilename(request, parent, isMain);
        if (resolvedRequest === dbPath) {
            return { query: queryFn };
        }
        if (resolvedRequest === authPath) {
            return { hashPassword: hashPasswordFn };
        }
        return originalLoad.apply(this, arguments);
    };

    try {
        return require('../utils/seed');
    } finally {
        Module._load = originalLoad;
        delete require.cache[seedPath];
    }
}

test('seedSuperAdmin updates existing super admin password from env', async () => {
    const originalEnv = {
        user: process.env.SUPER_ADMIN_USER,
        password: process.env.SUPER_ADMIN_PASSWORD
    };
    const calls = [];
    const { seedSuperAdmin } = loadSeedWithMocks({
        async queryFn(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('SELECT id FROM users WHERE role')) {
                return { rows: [{ id: 'super-admin-id' }] };
            }
            return { rows: [] };
        },
        async hashPasswordFn(password) {
            assert.equal(password, 'new-secret');
            return 'hashed-new-secret';
        }
    });

    process.env.SUPER_ADMIN_USER = 'admin';
    process.env.SUPER_ADMIN_PASSWORD = 'new-secret';

    try {
        await seedSuperAdmin(1);
    } finally {
        if (originalEnv.user === undefined) delete process.env.SUPER_ADMIN_USER;
        else process.env.SUPER_ADMIN_USER = originalEnv.user;
        if (originalEnv.password === undefined) delete process.env.SUPER_ADMIN_PASSWORD;
        else process.env.SUPER_ADMIN_PASSWORD = originalEnv.password;
    }

    assert.equal(calls.length, 2);
    assert.match(calls[1].sql, /UPDATE users/);
    assert.deepEqual(calls[1].params, ['admin', 'hashed-new-secret', 'super-admin-id']);
});
