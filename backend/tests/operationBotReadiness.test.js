const assert = require('node:assert/strict');
const test = require('node:test');

const operationBot = require('../bots/operationBot');

test.afterEach(() => {
    operationBot.__resetRoutingReadinessForTests();
});

test('waitForRoutingReady waits for a connecting tenant until group cache is updated', async () => {
    operationBot.__markRoutingExpectedForTests('tenant-1', 'bot-1');

    const readiness = operationBot.waitForRoutingReady({
        tenantId: 'tenant-1',
        timeoutMs: 100
    });

    assert.equal(operationBot.isRoutingReady('tenant-1'), false);

    await operationBot.updateGroupCache('bot-1', {
        async groupFetchAllParticipating() {
            return {
                'group-1@g.us': {
                    id: 'group-1@g.us',
                    subject: 'Ops',
                    participants: [{ id: 'user-1@s.whatsapp.net' }]
                }
            };
        }
    }, 'tenant-1');

    const result = await readiness;
    assert.deepEqual(result, { ready: true, timedOut: false });
    assert.equal(operationBot.isRoutingReady('tenant-1'), true);
});

test('routing readiness waits for all expected bots in a tenant to cache groups', async () => {
    operationBot.__markRoutingExpectedForTests('tenant-1', 'bot-1');
    operationBot.__markRoutingExpectedForTests('tenant-1', 'bot-2');

    const readiness = operationBot.waitForRoutingReady({
        tenantId: 'tenant-1',
        timeoutMs: 100
    });

    assert.equal(operationBot.isRoutingReady('tenant-1'), false);

    await operationBot.updateGroupCache('bot-1', {
        async groupFetchAllParticipating() {
            return {
                'group-1@g.us': {
                    id: 'group-1@g.us',
                    subject: 'Ops 1',
                    participants: [{ id: 'user-1@s.whatsapp.net' }]
                }
            };
        }
    }, 'tenant-1');

    assert.equal(operationBot.isRoutingReady('tenant-1'), false);

    await operationBot.updateGroupCache('bot-2', {
        async groupFetchAllParticipating() {
            return {
                'group-2@g.us': {
                    id: 'group-2@g.us',
                    subject: 'Ops 2',
                    participants: [{ id: 'user-2@s.whatsapp.net' }]
                }
            };
        }
    }, 'tenant-1');

    const result = await readiness;
    assert.deepEqual(result, { ready: true, timedOut: false });
    assert.equal(operationBot.isRoutingReady('tenant-1'), true);
});

test('routing readiness is true when no operation bots are expected', async () => {
    assert.equal(operationBot.isRoutingReady('tenant-empty'), true);
    assert.deepEqual(
        await operationBot.waitForRoutingReady({ tenantId: 'tenant-empty', timeoutMs: 10 }),
        { ready: true, timedOut: false }
    );
});

test('admin bot records are skipped by operation bot lifecycle', async () => {
    const queryFn = async (sql, params) => {
        assert.match(sql, /SELECT is_admin_bot FROM bot_status/i);
        assert.deepEqual(params, ['tenant-1', 'admin_bot']);
        return { rows: [{ is_admin_bot: true }] };
    };

    assert.equal(
        await operationBot.__isAdminBotRecordForTests('admin_bot', 'tenant-1', queryFn),
        true
    );
});

test('operation bot lifecycle only skips explicit admin bot rows', async () => {
    assert.equal(
        await operationBot.__isAdminBotRecordForTests('bot_FP', 'tenant-1', async () => ({ rows: [{ is_admin_bot: false }] })),
        false
    );

    assert.equal(
        await operationBot.__isAdminBotRecordForTests('bot_missing', 'tenant-1', async () => ({ rows: [] })),
        false
    );
});
