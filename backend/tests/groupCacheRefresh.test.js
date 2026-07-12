const assert = require('node:assert/strict');
const test = require('node:test');

process.env.GROUP_REFRESH_DEBOUNCE_MS = '15000';
process.env.GROUP_REFRESH_MIN_INTERVAL_MS = '60000';

const operationBot = require('../bots/operationBot');

const {
    __scheduleGroupCacheRefreshForTests: scheduleGroupCacheRefresh,
    __cancelGroupCacheRefreshForTests: cancelGroupCacheRefresh,
    __registerActiveSocketForTests: registerActiveSocket,
    __hasPendingGroupRefreshForTests: hasPendingGroupRefresh,
    __resetRoutingReadinessForTests: reset
} = operationBot;

const TENANT = 'tenant-1';
const BOT = 'bot-a';

function makeSock() {
    const sock = {
        fetchCalls: 0,
        async groupFetchAllParticipating() {
            sock.fetchCalls += 1;
            return {};
        }
    };
    return sock;
}

test('a burst of group events collapses into a single fetch', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.after(() => reset());

    const sock = makeSock();
    registerActiveSocket(TENANT, BOT, sock);

    // History sync trickles events out over ~30s. Under the old 1s debounce each
    // of these produced its own full fetch of every group.
    for (let i = 0; i < 7; i += 1) {
        scheduleGroupCacheRefresh(BOT, sock, TENANT, `event-${i}`);
        t.mock.timers.tick(5000);
    }

    t.mock.timers.tick(60000);
    await Promise.resolve();

    assert.equal(sock.fetchCalls, 1);
});

test('a refresh pending on a socket that closed never fires against it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.after(() => reset());

    const sock = makeSock();
    registerActiveSocket(TENANT, BOT, sock);
    scheduleGroupCacheRefresh(BOT, sock, TENANT, 'groups.upsert');

    // Socket closes while the refresh is still pending.
    reset();

    t.mock.timers.tick(60000);
    await Promise.resolve();

    assert.equal(sock.fetchCalls, 0);
});

test('cancelGroupCacheRefresh drops a pending refresh', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.after(() => reset());

    const sock = makeSock();
    registerActiveSocket(TENANT, BOT, sock);
    scheduleGroupCacheRefresh(BOT, sock, TENANT, 'groups.upsert');
    assert.equal(hasPendingGroupRefresh(TENANT, BOT), true);

    cancelGroupCacheRefresh(TENANT, BOT);
    assert.equal(hasPendingGroupRefresh(TENANT, BOT), false);

    t.mock.timers.tick(60000);
    assert.equal(sock.fetchCalls, 0);
});

test('a second refresh waits out the minimum interval rather than fetching again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.after(() => reset());

    const sock = makeSock();
    registerActiveSocket(TENANT, BOT, sock);

    scheduleGroupCacheRefresh(BOT, sock, TENANT, 'first');
    t.mock.timers.tick(15000);
    await Promise.resolve();
    assert.equal(sock.fetchCalls, 1);

    // A new event right after the fetch must not trigger another one 15s later —
    // the 60s floor pushes it out.
    scheduleGroupCacheRefresh(BOT, sock, TENANT, 'second');
    t.mock.timers.tick(20000);
    await Promise.resolve();
    assert.equal(sock.fetchCalls, 1);

    t.mock.timers.tick(45000);
    await Promise.resolve();
    assert.equal(sock.fetchCalls, 2);
});
