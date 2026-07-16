# Inbound WhatsApp Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay inbound WhatsApp DMs matching a per-tenant marker to a per-tenant HTTPS endpoint, HMAC-signed, so petag.id can verify phone ownership from the sender's number.

**Architecture:** A hook in `commandHandler`'s `messages.upsert` sits above the `!` command gate. Non-command DMs are checked against a cached per-tenant config row; on a marker match the true sender phone is resolved from the WhatsApp envelope (fail closed if only a LID is available) and POSTed to the tenant's destination with an `X-Zyron-Signature` HMAC header. Inline `fetch` with 3 attempts — no queue. Terminal failures write `operational_events`.

**Tech Stack:** Node 22 (global `fetch`), Express 4, `pg`, Baileys 6.7.23, `node:test`, React 19 + Vite + Tailwind v4 + Base UI.

**Spec:** `docs/superpowers/specs/2026-07-16-inbound-relay-design.md`

**Branch:** `feat/inbound-relay` (already created; the spec is committed at `fe7c6ba`).

## Global Constraints

- **Do not use axios.** `services/messageSender.js:1` requires axios but it is **not** in `backend/package.json` dependencies — it resolves only transitively via `baileys@6.7.23`. Use the global `fetch` (Node 22). Do not add axios to `package.json`; that is a separate concern (see spec "Out of scope").
- **`operational_events.severity` accepts only `'info' | 'warning' | 'error'`** — CHECK constraint at `services/schemaService.js:77`. `'warn'` throws.
- **`operational_events.actor_type` accepts only `'system' | 'user' | 'webhook' | 'schedule' | 'worker'`** — `services/schemaService.js:76`. Use the `'system'` default.
- **Never log or return the `secret`, and never log the message `text` (the blob).** Spec security requirements #3/#4.
- **`from` comes only from the WhatsApp envelope** (`key.senderPn` / `key.remoteJid`), never from message content. Security requirement #1.
- **Never insert an `await` above `claimMessage` in `commandHandler`'s `messages.upsert`.** The synchronous claim at `commandHandler.js:250-251` is what makes exactly one bot answer a group command.
- **DDL goes in `services/schemaService.js` only**, appended to `OPERATIONS_SCHEMA_STATEMENTS`. Not `db/init.sql`. House style: `TIMESTAMP` (not `TIMESTAMPTZ`), `REFERENCES tenants(id) ON DELETE CASCADE`.
- **Service style:** every service exports `createXService({ ...deps })` for tests plus module-level bound functions off a lazily-built default. Mirror `services/botProxyService.js`.
- **Test command:** `cd backend && npm test` (`node --test tests/*.test.js`). Run a single file with `node --test tests/<file>.test.js`.
- Tests must not touch a real database or network. Inject `queryFn` / `fetchFn` fakes.

## File Structure

| File | Responsibility |
|---|---|
| `backend/services/schemaService.js` *(modify)* | Add the `inbound_relays` DDL statement. |
| `backend/services/inboundRelayConfig.js` *(create)* | Read a tenant's relay config, TTL-cached. |
| `backend/utils/inboundSender.js` *(create)* | Resolve the true sender phone from a message key. Fail closed on LID. |
| `backend/utils/relaySignature.js` *(create)* | Build the exact request body and its HMAC. Pure. |
| `backend/services/inboundRelayService.js` *(create)* | POST with retry/403 policy; write audit events. |
| `backend/utils/relayUrl.js` *(create)* | Validate a tenant-supplied destination URL (SSRF guard). Pure. |
| `backend/routes/inboundRelays.js` *(create)* | `GET`/`PUT`/`DELETE /api/inbound-relays`. |
| `backend/index.js` *(modify)* | Mount the router. |
| `backend/bots/commandHandler.js` *(modify)* | The `maybeRelayInbound` hook above the `!` gate. |
| `frontend/src/pages/InboundRelay.tsx` *(create)* | Config page. |
| `frontend/src/App.tsx`, `frontend/src/components/Layout.tsx` *(modify)* | Route + nav entry. |

Tasks 1–5 are independent and can be done in any order. Task 6 needs Task 5. Task 7 needs Tasks 1, 2, 4. Task 8 needs Task 7 shipped only for a live demo, not to build.

---

### Task 1: Relay config table + cached lookup

**Files:**
- Modify: `backend/services/schemaService.js:133` (append to `OPERATIONS_SCHEMA_STATEMENTS`, after the two `ALTER TABLE` lines)
- Create: `backend/services/inboundRelayConfig.js`
- Test: `backend/tests/inboundRelayConfig.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createInboundRelayConfig({ queryFn, ttlMs }) -> { getRelay(tenantId, now?), invalidate(tenantId?) }`
  - `getRelay(tenantId, now?) -> Promise<{ marker, destination_url, secret, reply_text } | null>`
  - Module exports: `createInboundRelayConfig`, `getRelay`, `invalidateRelay`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inboundRelayConfig.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/inboundRelayConfig.test.js`
Expected: FAIL — `Cannot find module '../services/inboundRelayConfig'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/inboundRelayConfig.js`:

```js
const { query } = require('../utils/db');

const DEFAULT_TTL_MS = 60000;

/**
 * Resolves a tenant's inbound relay config. Consulted on every inbound DM, so an
 * uncached read would put a query on the chat path; cached briefly so a config
 * change still takes effect without a restart.
 */
function createInboundRelayConfig({ queryFn = query, ttlMs = DEFAULT_TTL_MS } = {}) {
    const cache = new Map();

    async function getRelay(tenantId, now = Date.now()) {
        if (!tenantId) return null;

        const cached = cache.get(tenantId);
        if (cached && now < cached.expiresAt) return cached.relay;

        try {
            const result = await queryFn(
                'SELECT marker, destination_url, secret, reply_text FROM inbound_relays WHERE tenant_id = $1 AND is_active = TRUE',
                [tenantId]
            );
            const relay = result.rows[0] || null;
            cache.set(tenantId, { relay, expiresAt: now + ttlMs });
            return relay;
        } catch (err) {
            // A DB blip must not become a relay outage: serve the last known
            // config rather than silently dropping verifications.
            return cached ? cached.relay : null;
        }
    }

    function invalidate(tenantId) {
        if (tenantId) cache.delete(tenantId);
        else cache.clear();
    }

    return { getRelay, invalidate };
}

const defaultService = createInboundRelayConfig();

module.exports = {
    createInboundRelayConfig,
    getRelay: (...args) => defaultService.getRelay(...args),
    invalidateRelay: (...args) => defaultService.invalidate(...args)
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/inboundRelayConfig.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Add the DDL**

In `backend/services/schemaService.js`, inside the `OPERATIONS_SCHEMA_STATEMENTS` array, add this entry immediately **before** the `// Unified bot migration:` comment (i.e. after the last `CREATE INDEX` string, currently line 130):

```js
    `CREATE TABLE IF NOT EXISTS inbound_relays (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        marker VARCHAR(64) NOT NULL,
        destination_url TEXT NOT NULL,
        secret TEXT NOT NULL,
        reply_text TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tenant_id)
    )`,
```

No separate index: `UNIQUE(tenant_id)` already provides the lookup index, and `tenant_id` is the only column the read path filters on.

- [ ] **Step 6: Verify the schema test still passes and covers the new statement**

Run: `cd backend && node --test tests/schemaService.test.js`
Expected: PASS. `ensureOperationsSchema` just iterates the array, so the new statement is executed in order with no code change.

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add backend/services/inboundRelayConfig.js backend/tests/inboundRelayConfig.test.js backend/services/schemaService.js
git commit -m "feat: add inbound_relays table and cached per-tenant config lookup

Consulted on every inbound DM, so the read is TTL-cached — including the
null result, or chatter from a tenant with no relay configured would query
on every message. A DB blip serves the last known config rather than
silently dropping verifications."
```

---

### Task 2: Sender resolution (fail closed on LID)

**Files:**
- Create: `backend/utils/inboundSender.js`
- Test: `backend/tests/inboundSender.test.js`

**Interfaces:**
- Consumes: `jidDecode` from `baileys`.
- Produces: `resolveSenderPhone(key) -> string | null` — canonical digits, or `null` meaning "do not relay".

**Why this task exists:** WhatsApp is migrating to LID addressing. `key.remoteJid` can be `<opaque>@lid` instead of `<phone>@s.whatsapp.net`. Naively stripping the suffix would put a LID in `from`, violating the one requirement the destination's whole trust model rests on. `null` must mean "do not forward" at every call site.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inboundSender.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveSenderPhone } = require('../utils/inboundSender');

test('resolves the phone number from a plain DM jid', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '6281234567890@s.whatsapp.net' }), '6281234567890');
});

test('prefers senderPn when remoteJid is a lid', () => {
    assert.equal(resolveSenderPhone({
        remoteJid: '99887766554433@lid',
        senderPn: '6281234567890@s.whatsapp.net'
    }), '6281234567890');
});

test('a lid-only sender resolves to null so the caller fails closed', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '99887766554433@lid' }), null);
});

test('accepts the legacy c.us server', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '6281234567890@c.us' }), '6281234567890');
});

test('a group jid resolves to null', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '120363419686014131@g.us' }), null);
});

test('a device-suffixed jid resolves to the bare number', () => {
    assert.equal(resolveSenderPhone({ remoteJid: '6281234567890:12@s.whatsapp.net' }), '6281234567890');
});

test('missing or empty keys resolve to null', () => {
    assert.equal(resolveSenderPhone({}), null);
    assert.equal(resolveSenderPhone(), null);
    assert.equal(resolveSenderPhone({ remoteJid: '' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/inboundSender.test.js`
Expected: FAIL — `Cannot find module '../utils/inboundSender'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/utils/inboundSender.js`:

```js
const { jidDecode } = require('baileys');

/**
 * The true phone number of a message's sender, or null when only a LID is
 * available.
 *
 * WhatsApp is migrating to LID addressing, where the envelope identifies the
 * sender by an opaque id instead of their number. senderPn carries the real
 * number when WhatsApp provides it — and it does not always provide it.
 *
 * Callers MUST treat null as "do not relay". The destination trusts `from` as
 * proof of phone ownership, so a LID must never be sent in its place.
 */
function resolveSenderPhone(key = {}) {
    const decoded = jidDecode(key.senderPn || key.remoteJid);
    if (!decoded) return null;
    if (decoded.server !== 's.whatsapp.net' && decoded.server !== 'c.us') return null;
    const digits = String(decoded.user || '').replace(/\D/g, '');
    return digits || null;
}

module.exports = { resolveSenderPhone };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/inboundSender.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/utils/inboundSender.js backend/tests/inboundSender.test.js
git commit -m "feat: resolve true sender phone from message key, fail closed on LID

WhatsApp is migrating to LID addressing, so remoteJid can be an opaque id
rather than a phone number, and nothing in the codebase handled that. A LID
in \`from\` would break the one property the verification flow trusts, so an
unresolvable sender returns null and callers must drop the message."
```

---

### Task 3: Request body + HMAC signature

**Files:**
- Create: `backend/utils/relaySignature.js`
- Test: `backend/tests/relaySignature.test.js`

**Interfaces:**
- Consumes: `node:crypto`.
- Produces:
  - `buildRelayBody({ from, text, messageId, timestamp }) -> string` — the exact bytes to send.
  - `signRelayBody(secret, body) -> string` — lowercase hex HMAC-SHA256.

**Why the body is a string, not an object:** the destination recomputes the HMAC over the raw bytes it receives. If any layer re-serializes the payload, key order or spacing can differ and every signature fails with `403`. Build once, hash that string, send that same string.

The test vector below is the one published to petag.id in `docs/petag-integration-brief.md`. Keeping it in a test means the brief and the implementation cannot silently drift apart.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/relaySignature.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const { buildRelayBody, signRelayBody } = require('../utils/relaySignature');

const VECTOR = {
    from: '6281234567890',
    text: 'PETAG-VERIFY:AbCdEf0123456789',
    messageId: '3EB0C767D26B8C3F1A2B',
    timestamp: 1752600000
};
const VECTOR_BODY = '{"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}';
const VECTOR_SECRET = 'test-secret-do-not-use-in-prod';
const VECTOR_SIG = 'a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e';

// This vector is published to petag.id in docs/petag-integration-brief.md.
// If it changes, their implementation breaks — update the brief too.
test('builds the documented body byte-for-byte', () => {
    assert.equal(buildRelayBody(VECTOR), VECTOR_BODY);
});

test('signs the documented test vector', () => {
    assert.equal(signRelayBody(VECTOR_SECRET, VECTOR_BODY), VECTOR_SIG);
});

test('field order is fixed: from, text, message_id, timestamp', () => {
    // Same values supplied in a different order must still serialize identically,
    // because the destination hashes raw bytes and key order changes the hash.
    const body = buildRelayBody({
        timestamp: 1752600000,
        messageId: '3EB0C767D26B8C3F1A2B',
        text: 'PETAG-VERIFY:AbCdEf0123456789',
        from: '6281234567890'
    });
    assert.equal(body, VECTOR_BODY);
});

test('the marker and blob are forwarded verbatim, untrimmed', () => {
    const body = buildRelayBody({ ...VECTOR, text: '  PETAG-VERIFY:xx  ' });
    assert.match(body, /"text":"  PETAG-VERIFY:xx  "/);
});

test('signature is lowercase hex of the exact bytes', () => {
    const sig = signRelayBody('k', 'some-body');
    assert.match(sig, /^[0-9a-f]{64}$/);
    assert.equal(sig, crypto.createHmac('sha256', 'k').update('some-body').digest('hex'));
});

test('a different key order produces a different signature (why we send the string)', () => {
    const reordered = '{"text":"PETAG-VERIFY:AbCdEf0123456789","from":"6281234567890","timestamp":1752600000,"message_id":"3EB0C767D26B8C3F1A2B"}';
    assert.notEqual(signRelayBody(VECTOR_SECRET, reordered), VECTOR_SIG);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/relaySignature.test.js`
Expected: FAIL — `Cannot find module '../utils/relaySignature'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/utils/relaySignature.js`:

```js
const crypto = require('crypto');

/**
 * The exact bytes sent as the request body.
 *
 * The destination recomputes the HMAC over the raw body it receives, so the
 * string built here must be the string that goes on the wire. Handing an object
 * to an HTTP client that re-serializes it can change key order or spacing, which
 * changes the hash and earns a 403.
 */
function buildRelayBody({ from, text, messageId, timestamp }) {
    return JSON.stringify({ from, text, message_id: messageId, timestamp });
}

function signRelayBody(secret, body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

module.exports = { buildRelayBody, signRelayBody };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/relaySignature.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/utils/relaySignature.js backend/tests/relaySignature.test.js
git commit -m "feat: build and sign the inbound relay request body

The destination hashes the raw bytes it receives, so the body is built once
as a string and that same string is both hashed and sent. The test pins the
exact vector published to petag.id, so the brief and the code cannot drift."
```

---

### Task 4: Relay service — POST, retry policy, audit

**Files:**
- Create: `backend/services/inboundRelayService.js`
- Test: `backend/tests/inboundRelayService.test.js`

**Interfaces:**
- Consumes: `buildRelayBody`, `signRelayBody` (Task 3); `logEvent` from `services/auditService`.
- Produces:
  - `createInboundRelayService({ fetchFn, auditFn, sleepFn, maxAttempts, backoffMs }) -> { forward, logDroppedSender }`
  - `forward({ tenantId, relay, from, text, messageId, timestamp }) -> Promise<{ ok: boolean, status: number|null, error?: string }>`
  - `logDroppedSender({ tenantId, messageId }) -> Promise<void>`
  - Module exports: `createInboundRelayService`, `forward`, `logDroppedSender`

`relay` is the row shape from Task 1: `{ marker, destination_url, secret, reply_text }`.

**Policy** (from the spec's Error handling table): `200`→done; `403`→**stop, no retry**, audit `error` (the shared secret is wrong; retrying cannot help and hides the fault); any other non-2xx / network error / timeout → retry, 3 attempts total; exhausted → audit `error`.

**Never put `text` or `secret` in an audit event.** `from` is permitted — it is operational need.

`auditService.logEvent` is used directly. It is callable today; only `queueService`'s injection of it is dead (`queueService.js:381`), which this task does not touch.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inboundRelayService.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const { createInboundRelayService } = require('../services/inboundRelayService');

const RELAY = {
    marker: 'PETAG-VERIFY:',
    destination_url: 'https://api.petag.id/webhooks/zyron',
    secret: 'test-secret-do-not-use-in-prod',
    reply_text: null
};
const MSG = {
    tenantId: 't1',
    relay: RELAY,
    from: '6281234567890',
    text: 'PETAG-VERIFY:AbCdEf0123456789',
    messageId: '3EB0C767D26B8C3F1A2B',
    timestamp: 1752600000
};

function okResponse(status = 200) {
    return { ok: status >= 200 && status < 300, status };
}

test('posts the signed body and reports success', async () => {
    const calls = [];
    const svc = createInboundRelayService({
        fetchFn: async (url, opts) => { calls.push({ url, opts }); return okResponse(200); },
        auditFn: async () => {}
    });

    const result = await svc.forward(MSG);

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.petag.id/webhooks/zyron');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(
        calls[0].opts.headers['X-Zyron-Signature'],
        'a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e'
    );
});

test('the body sent is a string, and it is the string that was signed', async () => {
    let sent = null;
    const svc = createInboundRelayService({
        fetchFn: async (url, opts) => { sent = opts.body; return okResponse(200); },
        auditFn: async () => {}
    });

    await svc.forward(MSG);

    assert.equal(typeof sent, 'string');
    assert.equal(sent, '{"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}');
});

test('403 stops immediately without retrying and audits an error', async () => {
    let calls = 0;
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => { calls += 1; return okResponse(403); },
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    const result = await svc.forward(MSG);

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(calls, 1, 'a wrong shared secret cannot be fixed by retrying');
    assert.equal(events.length, 1);
    assert.equal(events[0].severity, 'error');
    assert.equal(events[0].eventType, 'inbound_relay_rejected');
});

test('a 500 retries up to maxAttempts then audits an error', async () => {
    let calls = 0;
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => { calls += 1; return okResponse(500); },
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    const result = await svc.forward(MSG);

    assert.equal(calls, 3);
    assert.equal(result.ok, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'inbound_relay_failed');
    assert.equal(events[0].severity, 'error');
});

test('a network error retries and a later success wins', async () => {
    let calls = 0;
    const svc = createInboundRelayService({
        fetchFn: async () => {
            calls += 1;
            if (calls < 3) throw new Error('ECONNRESET');
            return okResponse(200);
        },
        auditFn: async () => {},
        sleepFn: async () => {}
    });

    assert.equal((await svc.forward(MSG)).ok, true);
    assert.equal(calls, 3);
});

test('audit events never carry the blob or the secret', async () => {
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => okResponse(500),
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    await svc.forward(MSG);

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('AbCdEf0123456789'), 'blob must not be logged');
    assert.ok(!serialized.includes('test-secret-do-not-use-in-prod'), 'secret must not be logged');
});

test('audit events use a severity the DB CHECK constraint accepts', async () => {
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => okResponse(500),
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    await svc.forward(MSG);
    await svc.logDroppedSender({ tenantId: 't1', messageId: 'abc' });

    for (const e of events) {
        assert.ok(['info', 'warning', 'error'].includes(e.severity), `bad severity: ${e.severity}`);
    }
});

test('an audit failure never breaks the relay result', async () => {
    const svc = createInboundRelayService({
        fetchFn: async () => okResponse(403),
        auditFn: async () => { throw new Error('db down'); },
        sleepFn: async () => {}
    });

    const result = await svc.forward(MSG);
    assert.equal(result.status, 403);
});

test('logDroppedSender records a warning', async () => {
    const events = [];
    const svc = createInboundRelayService({ auditFn: async (e) => { events.push(e); } });

    await svc.logDroppedSender({ tenantId: 't1', messageId: 'abc' });

    assert.equal(events.length, 1);
    assert.equal(events[0].severity, 'warning');
    assert.equal(events[0].eventType, 'inbound_relay_dropped');
    assert.equal(events[0].tenantId, 't1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/inboundRelayService.test.js`
Expected: FAIL — `Cannot find module '../services/inboundRelayService'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/inboundRelayService.js`:

```js
const { logEvent } = require('./auditService');
const { buildRelayBody, signRelayBody } = require('../utils/relaySignature');

const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 5000];

/**
 * Forwards an inbound WhatsApp message to a tenant's configured destination,
 * signed so the destination can trust it. Runs inline on the chat path rather
 * than through the delivery queue: the queue is shaped for outbound WhatsApp
 * sends (throttling, bot routing, cost stats), none of which apply to an HTTP
 * POST, and a verification the user is actively waiting on must not be paced.
 */
function createInboundRelayService({
    fetchFn = fetch,
    auditFn = logEvent,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxAttempts = MAX_ATTEMPTS,
    backoffMs = BACKOFF_MS
} = {}) {

    // The relay's outcome must not depend on the audit trail being writable.
    async function safeAudit(event) {
        try {
            await auditFn(event);
        } catch {
            // Intentionally swallowed.
        }
    }

    async function forward({ tenantId, relay, from, text, messageId, timestamp }) {
        const body = buildRelayBody({ from, text, messageId, timestamp });
        const signature = signRelayBody(relay.secret, body);
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const res = await fetchFn(relay.destination_url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Zyron-Signature': signature
                    },
                    body,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });

                if (res.status === 403) {
                    // Signature rejected: the shared secret is wrong on one side.
                    // Retrying cannot fix that and would bury the real fault.
                    await safeAudit({
                        tenantId,
                        eventType: 'inbound_relay_rejected',
                        severity: 'error',
                        entityType: 'inbound_relay',
                        entityId: messageId,
                        message: 'Inbound relay rejected: signature mismatch — check the shared secret',
                        metadata: { from, status: 403 }
                    });
                    return { ok: false, status: 403 };
                }

                if (res.ok) return { ok: true, status: res.status };

                lastError = `HTTP ${res.status}`;
            } catch (err) {
                lastError = err.message;
            }

            if (attempt < maxAttempts) {
                await sleepFn(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]);
            }
        }

        await safeAudit({
            tenantId,
            eventType: 'inbound_relay_failed',
            severity: 'error',
            entityType: 'inbound_relay',
            entityId: messageId,
            message: `Inbound relay failed after ${maxAttempts} attempts: ${lastError}`,
            metadata: { from, attempts: maxAttempts, last_error: lastError }
        });
        return { ok: false, status: null, error: lastError };
    }

    // A sender we could not resolve to a phone number is dropped rather than
    // relayed with a LID. That is invisible to the destination and to the user,
    // so it must be visible here.
    async function logDroppedSender({ tenantId, messageId }) {
        await safeAudit({
            tenantId,
            eventType: 'inbound_relay_dropped',
            severity: 'warning',
            entityType: 'inbound_relay',
            entityId: messageId,
            message: 'Inbound relay dropped: sender phone number unavailable (LID-only)',
            metadata: null
        });
    }

    return { forward, logDroppedSender };
}

const defaultService = createInboundRelayService();

module.exports = {
    createInboundRelayService,
    forward: (...args) => defaultService.forward(...args),
    logDroppedSender: (...args) => defaultService.logDroppedSender(...args)
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/inboundRelayService.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/inboundRelayService.js backend/tests/inboundRelayService.test.js
git commit -m "feat: forward inbound relay messages with retry and audit

403 means the shared secret is wrong, so it stops immediately rather than
retrying into a wall; everything else retries three times. Terminal failures
and LID drops write operational_events, since without the queue's bookkeeping
a lost verification would otherwise be invisible.

Uses global fetch, not axios: axios is only a transitive dep of baileys here."
```

---

### Task 5: Destination URL validation (SSRF guard)

**Files:**
- Create: `backend/utils/relayUrl.js`
- Test: `backend/tests/relayUrl.test.js`

**Interfaces:**
- Consumes: `node:net`.
- Produces: `validateRelayUrl(rawUrl) -> { ok: true, url: string } | { ok: false, error: string }`

**Why:** this feature lets a tenant admin choose a URL the server POSTs to. In production every service shares a netns on `127.0.0.1`, so an unguarded value puts ZYRON's own API in reach. Save-time validation cannot stop DNS rebinding; requiring TLS and rejecting literal private addresses is the proportionate guard.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/relayUrl.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const { validateRelayUrl } = require('../utils/relayUrl');

test('accepts a normal https url', () => {
    const result = validateRelayUrl('https://api.petag.id/webhooks/zyron');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://api.petag.id/webhooks/zyron');
});

test('rejects http', () => {
    assert.equal(validateRelayUrl('http://api.petag.id/webhooks/zyron').ok, false);
});

test('rejects a non-url', () => {
    assert.equal(validateRelayUrl('not a url').ok, false);
    assert.equal(validateRelayUrl('').ok, false);
    assert.equal(validateRelayUrl(null).ok, false);
});

test('rejects loopback', () => {
    assert.equal(validateRelayUrl('https://127.0.0.1/x').ok, false);
    assert.equal(validateRelayUrl('https://localhost/x').ok, false);
    assert.equal(validateRelayUrl('https://[::1]/x').ok, false);
});

test('rejects private v4 ranges', () => {
    assert.equal(validateRelayUrl('https://10.0.0.5/x').ok, false);
    assert.equal(validateRelayUrl('https://192.168.1.1/x').ok, false);
    assert.equal(validateRelayUrl('https://172.16.0.1/x').ok, false);
    assert.equal(validateRelayUrl('https://172.31.255.254/x').ok, false);
});

test('rejects link-local metadata addresses', () => {
    assert.equal(validateRelayUrl('https://169.254.169.254/latest/meta-data/').ok, false);
});

test('accepts public addresses just outside the private ranges', () => {
    assert.equal(validateRelayUrl('https://172.15.0.1/x').ok, true);
    assert.equal(validateRelayUrl('https://172.32.0.1/x').ok, true);
    assert.equal(validateRelayUrl('https://11.0.0.1/x').ok, true);
});

test('rejects private v6 ranges', () => {
    assert.equal(validateRelayUrl('https://[fd00::1]/x').ok, false);
    assert.equal(validateRelayUrl('https://[fe80::1]/x').ok, false);
});

test('rejects a non-https scheme that is still a valid url', () => {
    assert.equal(validateRelayUrl('file:///etc/passwd').ok, false);
    assert.equal(validateRelayUrl('ftp://example.com/x').ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/relayUrl.test.js`
Expected: FAIL — `Cannot find module '../utils/relayUrl'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/utils/relayUrl.js`:

```js
const net = require('net');

const PRIVATE_V4 = [
    /^0\./,
    /^10\./,
    /^127\./,
    /^169\.254\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./
];

/**
 * Validates a tenant-supplied relay destination.
 *
 * This URL is POSTed to by the server, so an unvalidated value is an SSRF
 * primitive — and in the production pod every service shares a netns on
 * 127.0.0.1, which would put ZYRON's own API within reach. Save-time validation
 * cannot stop DNS rebinding; requiring TLS and rejecting literal private
 * addresses is the proportionate guard.
 */
function validateRelayUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { ok: false, error: 'destination_url must be a valid URL' };
    }

    if (parsed.protocol !== 'https:') {
        return { ok: false, error: 'destination_url must use https' };
    }

    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

    if (host === 'localhost' || host.endsWith('.localhost')) {
        return { ok: false, error: 'destination_url must not point at localhost' };
    }

    if (net.isIPv4(host) && PRIVATE_V4.some((range) => range.test(host))) {
        return { ok: false, error: 'destination_url must not point at a private address' };
    }

    if (net.isIPv6(host)) {
        const isPrivateV6 = host === '::1'
            || host.startsWith('fc')
            || host.startsWith('fd')
            || host.startsWith('fe80');
        if (isPrivateV6) {
            return { ok: false, error: 'destination_url must not point at a private address' };
        }
    }

    return { ok: true, url: parsed.toString() };
}

module.exports = { validateRelayUrl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/relayUrl.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/utils/relayUrl.js backend/tests/relayUrl.test.js
git commit -m "feat: validate tenant-supplied relay destination urls

Letting a tenant admin name a URL the server POSTs to is an SSRF primitive,
and in the production pod every service shares 127.0.0.1 — so an unguarded
value reaches ZYRON's own API. Requires https and rejects literal private
addresses. Does not stop DNS rebinding; that is not what this guards."
```

---

### Task 6: Config API

**Files:**
- Create: `backend/routes/inboundRelays.js`
- Modify: `backend/index.js:19` (require) and `backend/index.js:90` (mount)
- Test: `backend/tests/inboundRelaysRoute.test.js`

**Interfaces:**
- Consumes: `validateRelayUrl` (Task 5), `invalidateRelay` (Task 1).
- Produces:
  - `GET /api/inbound-relays` → `{ success, exists, relay: { marker, destination_url, reply_text, is_active, secret_set } | null }`
  - `PUT /api/inbound-relays` body `{ marker, destination_url, secret?, reply_text?, is_active? }` → `{ success, relay }`
  - `DELETE /api/inbound-relays` → `{ success, deleted }`
  - Router test hooks: `router._getTargetTenantId`, `router._buildRelayResponse`

**`secret` is never returned.** `GET` reports `secret_set: boolean`. `PUT` without a `secret` field leaves the stored one unchanged, so the page can edit a marker without re-entering the secret.

**Tenant resolution** follows `operations.js`'s discipline but not its code: a super admin must name an explicit UUID `tenant_id`; everyone else is pinned to their JWT tenant. `getTenantScope` is only reachable as a test hook on the live router (`operations.js:748`) and is shaped for list queries; this resource is one row per tenant. See the spec's R4 note.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inboundRelaysRoute.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const router = require('../routes/inboundRelays');

const getTargetTenantId = router._getTargetTenantId;
const buildRelayResponse = router._buildRelayResponse;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

test('a tenant admin is pinned to their own JWT tenant', () => {
    const req = { user: { role: 'admin', tenantId: TENANT_A }, query: { tenant_id: TENANT_B }, body: {} };
    assert.equal(getTargetTenantId(req), TENANT_A, 'a client-supplied tenant_id must never win');
});

test('a super admin must name a tenant explicitly', () => {
    const req = { user: { role: 'super_admin', tenantId: null }, query: {}, body: {} };
    assert.throws(() => getTargetTenantId(req), /tenant_id is required/);
});

test('a super admin can act on a named tenant', () => {
    const req = { user: { role: 'super_admin', tenantId: null }, query: { tenant_id: TENANT_B }, body: {} };
    assert.equal(getTargetTenantId(req), TENANT_B);
});

test('a super admin cannot name a non-uuid tenant', () => {
    const req = { user: { role: 'super_admin', tenantId: null }, query: { tenant_id: 'not-a-uuid' }, body: {} };
    assert.throws(() => getTargetTenantId(req), /must be a valid UUID/);
});

test('the response never carries the secret', () => {
    const response = buildRelayResponse({
        marker: 'PETAG-VERIFY:',
        destination_url: 'https://api.petag.id/webhooks/zyron',
        secret: 'super-secret-value',
        reply_text: 'ok',
        is_active: true
    });

    assert.equal(response.secret_set, true);
    assert.equal(response.secret, undefined);
    assert.ok(!JSON.stringify(response).includes('super-secret-value'));
});

test('the response reports a missing secret', () => {
    const response = buildRelayResponse({
        marker: 'X:', destination_url: 'https://a.b/c', secret: '', reply_text: null, is_active: true
    });
    assert.equal(response.secret_set, false);
});

test('a null row builds a null response', () => {
    assert.equal(buildRelayResponse(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/inboundRelaysRoute.test.js`
Expected: FAIL — `Cannot find module '../routes/inboundRelays'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/routes/inboundRelays.js`:

```js
const express = require('express');
const { query } = require('../utils/db');
const { validateRelayUrl } = require('../utils/relayUrl');
const { invalidateRelay } = require('../services/inboundRelayConfig');

const router = express.Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MARKER_LENGTH = 64;

class BadRequestError extends Error {
    constructor(message) {
        super(message);
        this.statusCode = 400;
    }
}

function isValidUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * The tenant this request acts on. A tenant admin is always pinned to their JWT
 * tenant — a client-supplied tenant_id must never widen their reach. A super
 * admin has no tenant of their own, so they must name one explicitly.
 */
function getTargetTenantId(req) {
    if (!req.user || req.user.role !== 'super_admin') {
        return req.user.tenantId;
    }

    const requested = (req.query && req.query.tenant_id) || (req.body && req.body.tenant_id);
    if (!requested) throw new BadRequestError('tenant_id is required for super admin');
    if (!isValidUuid(requested)) throw new BadRequestError('tenant_id must be a valid UUID');
    return requested;
}

// The secret is write-only: it is needed to compute the HMAC, so it is stored in
// plaintext, and it must never travel back out to a browser.
function buildRelayResponse(row) {
    if (!row) return null;
    return {
        marker: row.marker,
        destination_url: row.destination_url,
        reply_text: row.reply_text,
        is_active: row.is_active,
        secret_set: Boolean(row.secret)
    };
}

function sendRouteError(res, error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
}

router.get('/', async (req, res) => {
    try {
        const tenantId = getTargetTenantId(req);
        const result = await query(
            'SELECT marker, destination_url, secret, reply_text, is_active FROM inbound_relays WHERE tenant_id = $1',
            [tenantId]
        );
        const relay = buildRelayResponse(result.rows[0]);
        res.json({ success: true, exists: Boolean(relay), relay });
    } catch (err) {
        sendRouteError(res, err);
    }
});

router.put('/', async (req, res) => {
    try {
        const tenantId = getTargetTenantId(req);
        const { marker, destination_url: destinationUrl, secret, reply_text: replyText, is_active: isActive } = req.body || {};

        if (typeof marker !== 'string' || !marker.trim()) {
            throw new BadRequestError('marker is required');
        }
        if (marker.trim().length > MAX_MARKER_LENGTH) {
            throw new BadRequestError(`marker must be at most ${MAX_MARKER_LENGTH} characters`);
        }

        const urlCheck = validateRelayUrl(destinationUrl);
        if (!urlCheck.ok) throw new BadRequestError(urlCheck.error);

        const existing = await query('SELECT secret FROM inbound_relays WHERE tenant_id = $1', [tenantId]);
        // Omitting `secret` means "leave it alone", so the marker or reply text
        // can be edited without the operator re-pasting the shared secret.
        const nextSecret = (typeof secret === 'string' && secret.length > 0)
            ? secret
            : existing.rows[0]?.secret;

        if (!nextSecret) throw new BadRequestError('secret is required');

        const result = await query(
            `INSERT INTO inbound_relays (tenant_id, marker, destination_url, secret, reply_text, is_active)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE))
             ON CONFLICT (tenant_id) DO UPDATE SET
                marker = EXCLUDED.marker,
                destination_url = EXCLUDED.destination_url,
                secret = EXCLUDED.secret,
                reply_text = EXCLUDED.reply_text,
                is_active = EXCLUDED.is_active,
                updated_at = NOW()
             RETURNING marker, destination_url, secret, reply_text, is_active`,
            [tenantId, marker.trim(), urlCheck.url, nextSecret, replyText || null, isActive]
        );

        invalidateRelay(tenantId);
        res.json({ success: true, relay: buildRelayResponse(result.rows[0]) });
    } catch (err) {
        sendRouteError(res, err);
    }
});

router.delete('/', async (req, res) => {
    try {
        const tenantId = getTargetTenantId(req);
        const result = await query('DELETE FROM inbound_relays WHERE tenant_id = $1 RETURNING id', [tenantId]);
        invalidateRelay(tenantId);
        res.json({ success: true, deleted: result.rows.length });
    } catch (err) {
        sendRouteError(res, err);
    }
});

router._getTargetTenantId = getTargetTenantId;
router._buildRelayResponse = buildRelayResponse;

module.exports = router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/inboundRelaysRoute.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Mount the router**

In `backend/index.js`, add after line 19 (`const webhookRoutes = require('./routes/webhook');`):

```js
const inboundRelayRoutes = require('./routes/inboundRelays');
```

And after line 90 (`app.use('/api/webhook', webhookRoutes);`), before `app.use('/api', operationsRoutes);`:

```js
app.use('/api/inbound-relays', inboundRelayRoutes);
```

Order matters: `operationsRoutes` is mounted at bare `/api`, so named routers must come first.

The global `authMiddleware` (`index.js:83`) already covers this path — it exempts only `/api/auth/login` and `/api/webhook/send` (`utils/midleware.js:4`). No route-level guard needed.

- [ ] **Step 6: Verify the app still loads and the suite passes**

Run: `cd backend && node -e "require('./index.js'); console.log('loaded ok')" && npm test`

Expected: `loaded ok` then PASS. (`index.js` only starts the server when it is the main module, `index.js:1364`, so requiring it is safe. It does start a 5-minute stats interval, so the process will not exit on its own — Ctrl-C it.)

- [ ] **Step 7: Commit**

```bash
git add backend/routes/inboundRelays.js backend/tests/inboundRelaysRoute.test.js backend/index.js
git commit -m "feat: add inbound relay config API

One relay per tenant, upserted on tenant_id. The secret is write-only: GET
reports secret_set rather than the value, and a PUT that omits it keeps the
stored one so the marker can be edited without re-pasting the secret.

A tenant admin is pinned to their JWT tenant; a super admin must name a
UUID-validated tenant explicitly."
```

---

### Task 7: The relay hook in commandHandler

**Files:**
- Modify: `backend/bots/commandHandler.js:1-11` (requires), `:238-251` (the hook), and the `module.exports` block at the end
- Test: `backend/tests/inboundRelayHook.test.js`

**Interfaces:**
- Consumes: `getRelay` (Task 1), `resolveSenderPhone` (Task 2), `forward` + `logDroppedSender` (Task 4).
- Produces: `maybeRelayInbound({ message, text, tenant, sock, deps })` exported for tests via `module.exports`.

**The invariant this task must not break:** `commandHandler.js:250-251` claims the message id **synchronously, before any `await`**, so exactly one member-bot answers a group command. The relay path must `return` before reaching the claim — never `await` above it.

**Guard order (cheapest first):** not a group → config (cached) → marker → sender → forward. Group chatter must be rejected before any cache or DB access.

Relay does not claim a dedup slot: a DM reaches exactly one bot, and the destination is idempotent on `message_id`. Claiming would let chatter evict command ids from the 500-entry FIFO.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/inboundRelayHook.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const { maybeRelayInbound } = require('../bots/commandHandler');

const TENANT = { id: 't1', brand_name: 'ZYRON' };
const RELAY = {
    marker: 'PETAG-VERIFY:',
    destination_url: 'https://api.petag.id/webhooks/zyron',
    secret: 's3cr3t',
    reply_text: null
};

function dmMessage(text, overrides = {}) {
    return {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'MSG1', ...overrides.key },
        messageTimestamp: 1752600000
    };
}

function deps(over = {}) {
    return {
        getRelay: async () => RELAY,
        forward: async () => ({ ok: true, status: 200 }),
        logDroppedSender: async () => {},
        ...over
    };
}

test('forwards a marker message from a DM', async () => {
    const forwarded = [];
    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: { sendMessage: async () => {} },
        deps: deps({ forward: async (a) => { forwarded.push(a); return { ok: true, status: 200 }; } })
    });

    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].tenantId, 't1');
    assert.equal(forwarded[0].from, '6281234567890');
    assert.equal(forwarded[0].text, 'PETAG-VERIFY:blob123');
    assert.equal(forwarded[0].messageId, 'MSG1');
    assert.equal(forwarded[0].timestamp, 1752600000);
});

test('a group message is never relayed, and never reaches the config lookup', async () => {
    let configLooked = false;
    let forwarded = false;
    await maybeRelayInbound({
        message: dmMessage(null, { key: { remoteJid: '120363419686014131@g.us' } }),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({
            getRelay: async () => { configLooked = true; return RELAY; },
            forward: async () => { forwarded = true; return { ok: true }; }
        })
    });

    assert.equal(forwarded, false);
    assert.equal(configLooked, false, 'group chatter must not cost a config lookup');
});

test('a non-marker DM is not relayed', async () => {
    let forwarded = false;
    await maybeRelayInbound({
        message: dmMessage(),
        text: 'hello there',
        tenant: TENANT,
        sock: {},
        deps: deps({ forward: async () => { forwarded = true; return { ok: true }; } })
    });

    assert.equal(forwarded, false);
});

test('a tenant with no relay configured is a no-op', async () => {
    let forwarded = false;
    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({ getRelay: async () => null, forward: async () => { forwarded = true; return { ok: true }; } })
    });

    assert.equal(forwarded, false);
});

test('a LID-only sender is dropped and logged, never forwarded', async () => {
    let forwarded = false;
    const dropped = [];
    await maybeRelayInbound({
        message: dmMessage(null, { key: { remoteJid: '99887766554433@lid', id: 'MSG9' } }),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({
            forward: async () => { forwarded = true; return { ok: true }; },
            logDroppedSender: async (a) => { dropped.push(a); }
        })
    });

    assert.equal(forwarded, false, 'a LID must never be sent as `from`');
    assert.deepEqual(dropped, [{ tenantId: 't1', messageId: 'MSG9' }]);
});

test('senderPn rescues a LID-addressed message', async () => {
    const forwarded = [];
    await maybeRelayInbound({
        message: dmMessage(null, {
            key: { remoteJid: '99887766554433@lid', senderPn: '6281234567890@s.whatsapp.net', id: 'MSG2' }
        }),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({ forward: async (a) => { forwarded.push(a); return { ok: true, status: 200 }; } })
    });

    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].from, '6281234567890');
});

test('the confirmation reply is sent only after a 200', async () => {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); } };

    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({ getRelay: async () => ({ ...RELAY, reply_text: 'Verified' }) })
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, '6281234567890@s.whatsapp.net');
    assert.equal(sent[0].content.text, 'Verified');
});

test('no confirmation reply when the forward failed', async () => {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); } };

    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({
            getRelay: async () => ({ ...RELAY, reply_text: 'Verified' }),
            forward: async () => ({ ok: false, status: 500 })
        })
    });

    assert.equal(sent.length, 0);
});

test('no confirmation reply when reply_text is empty', async () => {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); } };

    await maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({ getRelay: async () => ({ ...RELAY, reply_text: '' }) })
    });

    assert.equal(sent.length, 0);
});

test('a reply failure never surfaces — the relay already succeeded', async () => {
    const sock = { sendMessage: async () => { throw new Error('socket closed'); } };

    await assert.doesNotReject(() => maybeRelayInbound({
        message: dmMessage(),
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock,
        deps: deps({ getRelay: async () => ({ ...RELAY, reply_text: 'Verified' }) })
    }));
});

test('a missing messageTimestamp falls back to now', async () => {
    const forwarded = [];
    const message = dmMessage();
    delete message.messageTimestamp;

    await maybeRelayInbound({
        message,
        text: 'PETAG-VERIFY:blob123',
        tenant: TENANT,
        sock: {},
        deps: deps({ forward: async (a) => { forwarded.push(a); return { ok: true, status: 200 }; } })
    });

    assert.ok(Number.isFinite(forwarded[0].timestamp));
    assert.ok(forwarded[0].timestamp > 1700000000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/inboundRelayHook.test.js`
Expected: FAIL — `maybeRelayInbound is not a function`

- [ ] **Step 3: Add the requires**

In `backend/bots/commandHandler.js`, after line 3 (`const { query } = require('../utils/db');`):

```js
const { getRelay } = require('../services/inboundRelayConfig');
const { resolveSenderPhone } = require('../utils/inboundSender');
const inboundRelayService = require('../services/inboundRelayService');
```

- [ ] **Step 4: Add `maybeRelayInbound`**

In `backend/bots/commandHandler.js`, add this function immediately above the
`// ============================================================` banner that
precedes `function setupCommands` (currently line 230):

```js
// ============================================================
// Inbound relay: forward marker-prefixed DMs to the tenant's
// configured endpoint. Guards run cheapest-first so ordinary
// chatter costs nothing beyond a string check.
// ============================================================
async function maybeRelayInbound({ message, text, tenant, sock, deps = {} }) {
    const chatId = message.key?.remoteJid;
    // DM only. A group message would reach every member-bot, and a group
    // sender needs participantPn rather than senderPn — neither is supported.
    if (!chatId || chatId.endsWith('@g.us')) return;

    const getRelayFn = deps.getRelay || getRelay;
    const relay = await getRelayFn(tenant.id);
    if (!relay || !relay.marker || !text.startsWith(relay.marker)) return;

    const messageId = message.key.id;
    const from = resolveSenderPhone(message.key);
    if (!from) {
        // Only a LID was available. Forwarding it would put a non-phone-number
        // in `from`, which the destination trusts as proof of ownership.
        const logDropped = deps.logDroppedSender || inboundRelayService.logDroppedSender;
        await logDropped({ tenantId: tenant.id, messageId });
        return;
    }

    const forwardFn = deps.forward || inboundRelayService.forward;
    const result = await forwardFn({
        tenantId: tenant.id,
        relay,
        from,
        text,
        messageId,
        timestamp: Number(message.messageTimestamp) || Math.floor(Date.now() / 1000)
    });

    if (!result?.ok || !relay.reply_text) return;

    // In-session reply to a user who messaged first, so it carries none of the
    // cold-message ban risk the outbound throttle exists to manage — and it must
    // not depend on the queue. Its failure is cosmetic; the relay already landed.
    try {
        await sock.sendMessage(chatId, { text: relay.reply_text });
    } catch (err) {
        logger.warn(`[${tenant.id}] Inbound relay confirmation reply failed: ${err.message}`);
    }
}
```

- [ ] **Step 5: Wire the hook into `messages.upsert`**

In `backend/bots/commandHandler.js`, replace lines 245-251:

```js
        const text = extractMessageText(message);
        if (!text) return;
        const commandName = text.split(/\s+/)[0].toLowerCase();
        if (!commandName.startsWith('!')) return;

        // Dedup BEFORE any await — exactly one bot proceeds.
        if (!claimMessage(tenantId, message.key.id)) return;
```

with:

```js
        const text = extractMessageText(message);
        if (!text) return;

        // Inbound relay: markers are not commands, so this must run before the
        // '!' gate. It returns rather than falling through, which keeps the
        // claim below the first await on the command path. No dedup claim here:
        // a DM reaches exactly one bot, the destination is idempotent on
        // message_id, and claiming would let chatter evict command ids.
        if (!text.startsWith('!')) return maybeRelayInbound({ message, text, tenant, sock });

        const commandName = text.split(/\s+/)[0].toLowerCase();

        // Dedup BEFORE any await — exactly one bot proceeds.
        if (!claimMessage(tenantId, message.key.id)) return;
```

- [ ] **Step 6: Export `maybeRelayInbound`**

Add `maybeRelayInbound` to the `module.exports` object at the end of `backend/bots/commandHandler.js`, alongside the existing exports.

- [ ] **Step 7: Run test to verify it passes**

Run: `cd backend && node --test tests/inboundRelayHook.test.js`
Expected: PASS — 11 tests.

- [ ] **Step 8: Verify the command path did not regress**

Run: `cd backend && node --test tests/commandHandler.test.js`
Expected: PASS — the existing dedup and round-robin tests must still pass unchanged.

- [ ] **Step 9: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add backend/bots/commandHandler.js backend/tests/inboundRelayHook.test.js
git commit -m "feat: relay marker-prefixed inbound DMs to the tenant's endpoint

The hook sits above the '!' gate, which drops every non-command message
today. It returns rather than falling through, so the dedup claim stays
synchronously ahead of the command path's first await — that ordering is
what makes exactly one bot answer a group command.

Guards run cheapest-first: group chatter is rejected before any config
lookup. Relay takes no dedup slot, since a DM reaches one bot and the
destination is idempotent on message_id."
```

---

### Task 8: Config page

**Files:**
- Create: `frontend/src/pages/InboundRelay.tsx`
- Modify: `frontend/src/App.tsx:17` (import), `:38` (route)
- Modify: `frontend/src/components/Layout.tsx:22` (icon import), `:49` (nav entry)

**Interfaces:**
- Consumes: `GET`/`PUT`/`DELETE /api/inbound-relays` (Task 6).
- Produces: the `/inbound-relay` route.

**Note:** the frontend has no test runner (`frontend/package.json` has no `test` script), so this task ships untested like every other page. `npm run build` runs `tsc -b` and is the only gate.

Follow `frontend/src/pages/Webhook.tsx` — same `Card`/`Button`/`Badge` imports, same `getUser()?.tenantId` guard, same `fetchApi`/`postApi` usage. Note `fetchApi` has no PUT/DELETE wrapper; hand-roll `{ method: 'PUT', body: JSON.stringify(...) }` as `Webhook.tsx:72` does.

- [ ] **Step 1: Create the page**

Create `frontend/src/pages/InboundRelay.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { fetchApi } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Inbox, Save, Trash2 } from 'lucide-react';

interface Relay {
  marker: string;
  destination_url: string;
  reply_text: string | null;
  is_active: boolean;
  secret_set: boolean;
}

interface RelayResponse {
  success: boolean;
  exists: boolean;
  relay: Relay | null;
}

export default function InboundRelay() {
  const [relay, setRelay] = useState<Relay | null>(null);
  const [marker, setMarker] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [replyText, setReplyText] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const user = getUser();

  useEffect(() => { loadRelay(); }, []);

  if (!user?.tenantId) {
    return <div className="text-muted-foreground">No tenant context. Super admin cannot manage inbound relays directly.</div>;
  }

  async function loadRelay() {
    setLoading(true);
    try {
      const data = await fetchApi<RelayResponse>('/inbound-relays');
      setRelay(data.relay);
      if (data.relay) {
        setMarker(data.relay.marker);
        setDestinationUrl(data.relay.destination_url);
        setReplyText(data.relay.reply_text || '');
        setIsActive(data.relay.is_active);
      }
    } catch {
      setRelay(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      await fetchApi('/inbound-relays', {
        method: 'PUT',
        body: JSON.stringify({
          marker,
          destination_url: destinationUrl,
          // Omitted when blank, which tells the API to keep the stored secret.
          ...(secret ? { secret } : {}),
          reply_text: replyText || null,
          is_active: isActive,
        }),
      });
      setSecret('');
      setSaved(true);
      await loadRelay();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save relay');
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this relay? Inbound verification messages will stop being forwarded.')) return;
    setError(null);
    try {
      await fetchApi('/inbound-relays', { method: 'DELETE' });
      setRelay(null);
      setMarker('');
      setDestinationUrl('');
      setSecret('');
      setReplyText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete relay');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Inbound Relay</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Inbox className="h-4 w-4" />Configuration
            {relay && <Badge variant={relay.is_active ? 'default' : 'secondary'}>{relay.is_active ? 'Active' : 'Paused'}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-sm font-medium">Marker</label>
                <Input value={marker} onChange={(e) => setMarker(e.target.value)} placeholder="PETAG-VERIFY:" />
                <p className="text-xs text-muted-foreground">Direct messages starting with this text are forwarded. Everything else is ignored.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Destination URL</label>
                <Input value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://api.petag.id/webhooks/zyron" />
                <p className="text-xs text-muted-foreground">Must be https. Private and loopback addresses are rejected.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Shared Secret</label>
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={relay?.secret_set ? 'Stored — leave blank to keep it' : 'Paste the shared HMAC secret'}
                />
                <p className="text-xs text-muted-foreground">
                  Used to sign every forwarded message (<code className="bg-muted px-1 py-0.5 rounded">X-Zyron-Signature</code>). Must match the destination's secret exactly. Never shown again after saving.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Confirmation Reply (optional)</label>
                <textarea
                  className="w-full min-h-20 rounded-md border bg-background px-3 py-2 text-sm"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Leave blank to send no reply"
                />
                <p className="text-xs text-muted-foreground">Sent in-chat only after the destination accepts the message.</p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Active
              </label>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {saved && <p className="text-sm text-muted-foreground">Saved.</p>}

              <div className="flex gap-2">
                <Button onClick={handleSave}>
                  <Save className="h-4 w-4 mr-2" />Save
                </Button>
                {relay && (
                  <Button variant="outline" className="text-destructive" onClick={handleDelete}>
                    <Trash2 className="h-4 w-4 mr-2" />Delete
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

In `frontend/src/App.tsx`, add after line 17 (`import Webhook from '@/pages/Webhook';`):

```tsx
import InboundRelay from '@/pages/InboundRelay';
```

And after line 38 (`<Route path="/webhook" element={<Webhook />} />`):

```tsx
            <Route path="/inbound-relay" element={<InboundRelay />} />
```

- [ ] **Step 3: Add the nav entry**

In `frontend/src/components/Layout.tsx`, add `Inbox` to the `lucide-react` import block (line 22 area, alongside `Plug`):

```tsx
  Inbox,
```

And in `navItems`, after the `/webhook` entry (line 49):

```tsx
      { path: '/inbound-relay', label: 'Inbound Relay', icon: Inbox },
```

It belongs inside the `user?.tenantId ? [...]` block — a super admin has no tenant and the page self-guards.

- [ ] **Step 4: Verify the build typechecks**

Run: `cd frontend && npm run build`
Expected: PASS — `tsc -b` clean, then a Vite build. If `Input` is not exported from `@/components/ui/input`, check the actual export in that file and adjust the import; the repo uses Base UI, not Radix.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/InboundRelay.tsx frontend/src/App.tsx frontend/src/components/Layout.tsx
git commit -m "feat: add inbound relay config page

Single form per tenant, on the Webhook page's pattern. The secret field is
write-only: it shows whether one is stored and stays blank on load, and a
blank field on save keeps the existing secret."
```

---

## Verification

After all tasks:

- [ ] `cd backend && npm test` — full suite passes.
- [ ] `cd frontend && npm run build` — typechecks.
- [ ] Bring up the stack, configure a relay from the dashboard against a local receiver, and send a DM starting with the marker from a real WhatsApp account. Confirm the receiver gets a POST whose `X-Zyron-Signature` verifies against the raw body, and whose `from` is the sender's real number.
- [ ] Send a DM that does not start with the marker — nothing is forwarded.
- [ ] Send a `!hi` in a group — exactly one bot answers, as before.
- [ ] Point the receiver at a 403 response — confirm one attempt only, and an `error` row in the Timeline.

## Coordination

`docs/petag-integration-brief.md` is committed at `fe7c6ba` and must reach the petag.id team before their side is finalized. It flags four things that break the integration if unhandled: `message_id` is not `wamid.*`, LID drops mean some verifications never arrive, `403` must mean signature-mismatch only, and the bot number needs pinning. The signing test vector in Task 3 is the same one published there.
