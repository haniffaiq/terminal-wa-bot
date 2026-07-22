# Half-Open Socket Recovery — Design

**Date:** 2026-07-22
**Status:** Approved
**Driver:** A bot's WhatsApp socket can die half-open (TCP dead, no close event), leaving it silently offline for hours. `admin_bot1` sat dead ~28h. For the petag OTP number, a silent-dead bot means users cannot log in, with no signal.

## Goal

Make bot recovery act on **true liveness** — an active round-trip probe — instead of two DB signals that both lie. Detect and auto-reconnect half-open sockets. Affects all bots.

## The bug (confirmed from code)

- `botWatchdog.js:35` queries `WHERE bs.status <> 'open'`. A half-open socket leaves `bot_status` frozen at `'open'`, so the watchdog **never sees it**.
- `bot_status` freezes on half-open (no event updates it). `bot_health.last_seen_at` is refreshed **only** on connect (`operationBot.js:218`, the sole `markOnline` caller), so the 120s staleness sweep (`botHealthService.js:177`, wired at `index.js:1312`) flips every healthy idle bot to `offline` 120s after connect. Neither signal reflects "socket alive now".
- `ws.readyState` does **not** detect half-open: TCP is dead but the local socket still reports OPEN (no FIN/RST received). Only a failed round-trip detects it.
- Keepalive presence (`keepAliveService.js:60`) fires every 39 min and keeps the socket warm, but writes nothing to the DB and is the tenant's only defense — if it fails, nothing acts.

## Confirmed contract (unchanged)

- **"Intended up" = has creds** (`auth_sessions` key `creds`). Existing watchdog contract.
- Permanent delete (`stopOperationBot` → `deleteBotRecords`) removes creds → not revived.
- Temporary disconnect (`disconnectBotForce`) keeps creds, status `close`, drops socket → revived. Pre-existing; unchanged.
- `connectBot` (`operationBot.js:389`) already ends+deletes an existing socket before reconnecting, so a probe-failure path just calls `reconnectFn` — no separate teardown needed.
- `connectBot` guards `if (reconnectTimers[key] === 'connecting') return` (`:375`), so a reconnect call on a connecting bot is a no-op.

## Decisions (locked)

- Probe mechanism: **`sendPresenceUpdate('available')`**, wrapped in a timeout race. Presence is normal WhatsApp client traffic (low ban risk) and is a real round-trip, so it detects half-open.
- Placement: **consolidated into the watchdog**. It already runs every 60s and holds `reconnectFn` + backoff. It becomes the single liveness authority and stops trusting `bot_status`.
- Probe timeout ~5s: a write to a half-open TCP buffers and never rejects, so a bare probe would hang forever. The timeout is what turns "hanging write" into "dead signal".
- Skip bots mid-reconnect (`reconnectTimers[key] === 'connecting'`) to avoid thrash.

## Core change — `services/botWatchdog.js`

Query drops the `<> 'open'` filter → **all creds-holding bots in active tenants**. Then per bot:

```
if isReconnecting(tenantId, botId):        skip          // settling; don't probe
sock = getBotSocket(tenantId, botId)
if !sock:                                                  // clean death / disconnect
    if backoff elapsed: reconnectFn(); bump backoff
else:
    alive = await probeWithTimeout(sock, probeTimeoutMs)   // presence race
    if alive:
        noteConnected(key)                                 // clear backoff
        await botHealth.markSuccess({tenantId, botId})     // refresh last_seen
    else:                                                  // half-open
        if backoff elapsed: reconnectFn(); bump backoff    // reconnectFn tears down stale socket
```

`bot_status` is still updated elsewhere for the dashboard, but the revive decision no longer reads it.

### probeWithTimeout

```js
function probeWithTimeout(sock, timeoutMs) {
    return Promise.race([
        Promise.resolve().then(() => probeBot(sock)).then(() => true).catch(() => false),
        new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
    ]);
}
```
`probeBot` default `sock => sock.sendPresenceUpdate('available')`; injectable for tests.

### Backoff, corrected

`noteConnected` (currently zero callers) is finally wired: a successful probe clears the bot's backoff. Backoff is bumped only when a reconnect is actually triggered — fixing the prior behavior where it incremented on every tick including successful revive.

## `bots/operationBot.js`

Expose `isReconnecting(tenantId, botId)` → `reconnectTimers[`${tenantId}:${botId}`] === 'connecting'`. `getBotSocket` and `reconnectSingleBot` already exist and are used.

## `services/botHealthService.js`

No change. `markSuccess` already refreshes `last_seen_at`. Because the watchdog runs every 60s and the staleness sweep is 120s, a healthy bot is now marked-success within the window and no longer false-flips to `offline` — resolving the `bot_status=open` vs `bot_health=offline` split.

## Constants

| Name | Value | Status |
|---|---|---|
| `BOT_WATCHDOG_INTERVAL_MS` | 60000 | existing |
| `BOT_WATCHDOG_PROBE_TIMEOUT_MS` | 5000 | new |
| `BOT_HEALTH_STALE_AFTER_MS` | 120000 | existing (now cadence-matched) |
| backoff base / max | 60000 / 900000 | existing |

## Testing (`tests/botWatchdog.test.js`)

All with injected fakes, no DB/network:

- socket present + probe resolves → no reconnect; `noteConnected` + `markSuccess` called
- socket present + probe hangs past `probeTimeoutMs` → reconnect (use tiny timeout + never-resolving probe)
- socket present + probe throws → reconnect
- no socket → reconnect (existing behavior preserved)
- `isReconnecting` true → skipped, no probe, no reconnect
- query no longer excludes `status='open'` (a status=open bot is evaluated)
- backoff: reconnect bumps; probe-success clears

## Error handling

- Probe never throws out of the tick — race maps any failure to `false`.
- A `markSuccess` DB error must not break the tick; wrap it so a health-write blip doesn't stop recovery.
- Reconnect respects the existing `'connecting'` guard, so a redundant call is a safe no-op.

## Out of scope

- Redefining disconnect/delete semantics (kept as-is).
- The 39-min group keepalive message (separate concern; its presence layer stays).
- Making keepalive presence itself update health (the watchdog now owns liveness).

## Rollout

1. TDD the watchdog change + `isReconnecting`.
2. Full suite (`cd backend && npm test`) + run on `node:20-alpine` (production runtime).
3. Deploy via `deploy-podman.sh`. Watchdog change means a bot dying half-open now self-heals within ~1 probe interval instead of sitting dead.
4. Watch: a bot going quiet should now show a watchdog reconnect within ~60–120s, not silence.
