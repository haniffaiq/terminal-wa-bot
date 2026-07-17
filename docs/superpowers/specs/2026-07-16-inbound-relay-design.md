# Inbound WhatsApp Relay — Design

**Date:** 2026-07-16
**Status:** Approved
**Driver:** petag.id inbound OTP verification (`zyron-inbound-integration.md`), generalized to all tenants.

## Goal

Give ZYRON a new capability: relay **inbound** WhatsApp messages matching a
tenant-configured marker to a tenant-configured HTTPS endpoint, signed with a
tenant-configured HMAC secret.

Every existing pipeline in ZYRON is outbound. This is the first inbound path.

petag.id is the first consumer, not a special case. The marker
(`PETAG-VERIFY:`), destination, and secret are per-tenant configuration, never
constants.

ZYRON does not decrypt, parse, or interpret the payload. It is a dumb, signed
relay. petag.id owns the AES-256-GCM key and all verification logic.

## Decisions (locked)

- **Generic feature, petag = first tenant.** Marker/destination/secret are per-tenant config rows.
- **One relay per tenant.** `UNIQUE(tenant_id)`. If multiple markers per tenant are ever needed, adding `marker` to the unique key is a cheap migration.
- **Inline HTTP with 3-attempt backoff. No queue, no new table for events.** Rationale below.
- **Fail closed on LID.** If the true phone number cannot be resolved, do not forward. Log and drop.
- **DM only.** Group messages are never relayed.
- **Confirmation reply is per-tenant text**, sent only after the destination returns `200`. Empty = disabled.
- **DDL lives in `services/schemaService.js` only**, not `db/init.sql`.
- **Config surface is a dashboard page** (`Inbound Relay`), tenant self-service.

### Why no queue

The outbound pipeline (`message_jobs` + BullMQ + `deliveryWorker`) is shaped
around "send a WhatsApp message to a target": it has CHECK constraints on
`source`/`type`, a meaningless `selected_bot_id` for this use, and
`sendThrottle` — a WhatsApp anti-ban pacer that is irrelevant to an HTTP POST
and would actively delay an OTP. Relay rows would also pollute
`usage-costs`/statistics, which exist to benchmark WhatsApp send cost.

The durability argument for a queue is weaker here than it looks: **OTP
verification is user-retryable**. A lost relay means one user taps the link
again. Unlike a broadcast, the loss is neither silent nor unrecoverable — the
user is actively waiting and will retry. A dedicated table + worker + queue for
a POST that succeeds in ~50ms is not proportionate.

What a queue *would* have bought and we keep anyway: **observability**. Every
terminal failure writes `operational_events`, so a dropped verification is
visible in the Timeline page rather than invisible.

## Confirmed facts (from code audit)

- `commandHandler.js:248` — `if (!commandName.startsWith('!')) return;` drops every non-command message. A `PETAG-VERIFY:` message dies here today.
- `setupCommands(sock, botId, tenant, deps)` (`commandHandler.js:234`) already has `tenant` in scope. **Tenant is determined by which bot number the user messaged** — not derived from message content. This satisfies the spec's security requirement #1 for free and needs no new mechanism.
- `commandHandler.js:250-251` — the dedup claim is synchronous *before any `await`*, so exactly one member-bot handles a group command. **Correction (verified during implementation):** an `await` above the claim does **not** break dedup correctness. `claimMessage` is synchronous and JS is single-threaded, so its check-and-set is atomic on resume — with an await above it, both handlers yield, the first to resume claims, the second finds the id taken. Still exactly one. This was confirmed by injecting an `await` above the claim and watching the regression test still pass. What the early claim actually buys is **avoided work**: one bot does the async work per group message instead of every member-bot. That is a cost property, not a correctness one. The relay hook still returns before the claim — for that cost reason, and to keep relay traffic out of the dedup FIFO.
- Baileys **6.7.23** (`package.json:13`) `WAMessageKey` carries `senderLid?`, `senderPn?`, `participantLid?`, `participantPn?` (`Types/Message.d.ts:16-23`). `JidServer` includes `'lid'`; `isLidUser`/`jidDecode`/`jidNormalizedUser` are exported (`WABinary/jid-utils.d.ts:7,17,25,35`).
- **ZYRON has zero LID handling.** `grep -rn 'lid|senderPn|jidDecode|jidNormalizedUser' bots utils services routes index.js` returns nothing.
- `services/auditService.js` is **structurally sound and callable today** — `createAuditService({ queryFn })` is DI-friendly and the module-level `logEvent(...)` export works. It is unused only because `queueService.js:381` constructs its default with no deps, so `safeAudit` returns early. Calling `auditService.logEvent` from the relay needs **no** repair to that wiring, and gives the module its first live caller.
- `db/init.sql` and `services/schemaService.js` maintain byte-identical DDL for 8 tables. `init.sql` runs only on an empty volume; the production podman pod has an existing volume, so `init.sql` will never run for a new table. `schemaService.js` runs at every boot and is idempotent.
- `webhook_keys.api_key` is already stored plaintext — precedent for the HMAC secret below.
- `getTenantScope()` (`routes/operations.js:58-73`) is the only rigorous tenant-scoping helper in the repo; the inline routes in `index.js` use three inconsistent ad-hoc patterns.
- `PUT /api/bots/:botId/proxy` (`routes/operations.js:634`) validates a URL eagerly at save time — precedent for destination URL validation.

---

## Data model

```sql
CREATE TABLE IF NOT EXISTS inbound_relays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    marker VARCHAR(64) NOT NULL,
    destination_url TEXT NOT NULL,
    secret TEXT NOT NULL,
    reply_text TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (tenant_id)
)
```

Appended to `OPERATIONS_SCHEMA_STATEMENTS` in `services/schemaService.js` only.
House style there is `TIMESTAMP` (not `TIMESTAMPTZ`) and
`REFERENCES tenants(id) ON DELETE CASCADE`; this matches.

`secret` is **plaintext by necessity** — HMAC-SHA256 is symmetric, so the value
is needed to compute the signature and cannot be hashed like a password. This is
a deliberate, bounded choice, not an oversight. It must never be logged, and it
is never returned by the read API (see below). Encryption at rest would require
key management and is out of scope.

## Components

### R1. Relay hook (`backend/bots/commandHandler.js`)

Inserted **above** the `!` gate, structured so the command path's dedup
invariant is untouched:

```js
const text = extractMessageText(message);
if (!text) return;

// Inbound relay: markers are not commands, so this must run before the '!' gate.
// DM-shaped only — one bot receives it, and the relay target is idempotent on
// message_id, so no dedup claim is needed here.
if (!text.startsWith('!')) return maybeRelayInbound({ message, text, tenant, sock });

// Dedup BEFORE any await — exactly one bot proceeds.
if (!claimMessage(tenantId, message.key.id)) return;
```

Consequences, in order:

- The command path still claims before its first `await`. No regression.
- Relay never consumes a `DEDUP_CAP` (500/tenant) slot, so chatter cannot evict
  command message ids.
- Group chatter is rejected by the DM guard inside `maybeRelayInbound` before
  any DB or cache access.

`maybeRelayInbound` guard order (cheapest first):

1. `message.key.remoteJid` is not `@g.us` — else return.
2. Load relay config for the tenant (60s TTL cache, `botProxyService` pattern) — inactive/absent → return.
3. `text.startsWith(relay.marker)` — else return.
4. Resolve sender phone (R2). `null` → log `warning`, return.
5. Forward (R3).

The DM guard closes two things at once: multiple bots relaying the same group
message, and the need to resolve `participantPn` for group senders. Group
inbound is explicitly unsupported.

### R2. Sender resolution (`backend/utils/inboundSender.js`)

```js
function resolveSenderPhone(key) {
    // senderPn carries the phone-number JID when WhatsApp addresses by LID.
    const decoded = jidDecode(key.senderPn || key.remoteJid);
    if (!decoded) return null;
    if (decoded.server !== 's.whatsapp.net' && decoded.server !== 'c.us') return null;
    return decoded.user.replace(/\D/g, '') || null;
}
```

`null` means we could only obtain a LID. **Do not forward.** Write
`operational_events` with severity `warning` and drop. Fail closed: a wrong `from`
is more dangerous than a failed login, because the destination's entire trust
model rests on `from` being the true sender.

WhatsApp JIDs are already canonical international digits with no `+` and no
leading zero, so the spec's `08123…` → `628123…` rule does not apply to this
source. **Do not reuse `normalizeWebhookTarget` (`webhook.js:53`)** — that
normalizer exists for user-supplied input, not authoritative JIDs.

### R3. Relay service (`backend/services/inboundRelayService.js`)

`createInboundRelayService({ queryFn, fetchFn, auditFn })` — DI-shaped to
match `botProxyService`/`auditService` so tests inject fakes.

**HTTP client is the global `fetch`**, not axios. `services/messageSender.js:1`
requires axios, but axios is **not a declared dependency** of `backend/package.json`
— it resolves only because `baileys@6.7.23` happens to depend on it
(`npm ls axios` confirms). That is a latent boot failure for the existing
`media_url` path if baileys ever drops it, and this design will not deepen the
debt. Node 22 ships `fetch` globally. (Repairing `messageSender`'s undeclared
dependency is out of scope here — see Out of scope.)

Serialize once, hash those bytes, send those bytes:

```js
const body = JSON.stringify({ from, text, message_id, timestamp });
const signature = crypto.createHmac('sha256', relay.secret).update(body).digest('hex');
const res = await fetchFn(relay.destination_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Zyron-Signature': signature },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
});
```

Passing an **object** to a client that re-serializes it would produce bytes that
may differ from what was hashed — the destination recomputes over the raw body
and returns `403`. `body` must be the same string that was hashed. The string is
load-bearing.

Field mapping:

| Field | Source |
|---|---|
| `from` | `resolveSenderPhone(message.key)` — never from message content |
| `text` | full body verbatim, marker included, untrimmed |
| `message_id` | `message.key.id` |
| `timestamp` | `Number(message.messageTimestamp)`, fallback `Math.floor(Date.now()/1000)` |

### R4. Config API (`backend/routes/inboundRelays.js`)

`GET` / `PUT` / `DELETE /api/inbound-relays`, mounted alongside the other named
routers in `index.js` (before `app.use('/api', operationsRoutes)`).

Tenant resolution follows the **discipline** of `operations.js` — a super admin
must name an explicit, UUID-validated `tenant_id`; everyone else is pinned to
their JWT tenant — via a small local helper, not by importing from
`operations.js`. Two reasons: `getTenantScope` is only reachable as
`router._getTenantScope`, a test hook bolted onto the live router object
(`operations.js:748`), and its shape is wrong here — it builds a SQL clause and
pushes params for **list** queries, while this resource is one row per tenant.
The right analogue is `getReconnectTenantId` (`operations.js:75-89`), which
answers "which single tenant am I acting on". Extracting a shared helper out of
`operations.js` is deliberately not attempted here.

`GET` **never returns `secret`**; it returns `secret_set: boolean`. `PUT`
accepts a new secret or omits the field to leave it unchanged.

**Destination URL validation at save time**: require `https://`, reject private
and loopback ranges. This feature hands a tenant admin control over a URL the
server POSTs to — a new SSRF surface introduced by this design, so it is guarded
here rather than left as a known hole. The production pod runs all services on
a shared netns at `127.0.0.1`, so without this guard a tenant could aim the
relay at ZYRON's own API. Save-time validation does not stop DNS rebinding;
`https` + private-range rejection is the proportionate mitigation.

### R5. Dashboard page (`frontend/src/pages/InboundRelay.tsx`)

Single form on the `Webhook.tsx` pattern: marker, destination URL, secret
(write-only, shows `secret_set` state), reply text, active toggle. Nav entry
gated on `user?.tenantId` like the other tenant-admin pages.

## Delivery flow

```
user taps wa.me/<bot>?text=PETAG-VERIFY:<blob>
  → WA delivers to a socket owned by tenant T      ← tenant fixed here, not from content
  → commandHandler messages.upsert
  → maybeRelayInbound: DM? config? marker? sender resolvable?
  → POST destination_url, signed
  → 200 → optional reply_text
```

## Error handling

| Outcome | Action |
|---|---|
| `200` | Done. Send `reply_text` via the receiving socket if non-empty. |
| `403` | **No retry.** Signature rejected ⇒ the shared secret is misconfigured; retrying cannot help. `operational_events` severity `error`. |
| Other non-2xx, network error, timeout | Retry with backoff, 3 attempts total. |
| Attempts exhausted | `operational_events` severity `error`. |
| Sender is LID-only | Do not forward. `operational_events` severity `warning`. |

At-least-once is acceptable — the destination is idempotent on `message_id`.

The confirmation reply is sent directly through the receiving bot's socket,
bypassing the queue. This mirrors `keepAliveService`'s deliberate bypass
(`keepAliveService.js:19-21`): it is an **in-session reply** to a user who
messaged first, so it carries none of the cold-message ban risk that
`sendThrottle` exists to manage, and it must not depend on Redis or pollute
delivery stats.

Never log `secret` or the payload blob. Log `from` + `message_id` only to the
extent operations requires.

## Testing

`cd backend && npm test` (`node --test tests/*.test.js`).

- `inboundRelay.test.js` — marker match/miss; DM-only guard rejects `@g.us`; LID-only fails closed; resolution prefers `senderPn` over `remoteJid`; **command path regression: dedup still claims before the first `await`**.
- `inboundRelaySigning.test.js` — HMAC lowercase hex over exact bytes; the bytes hashed are the bytes sent.
- `inboundRelayRetry.test.js` — `403` does not retry; 5xx retries 3×; exhaustion writes an audit event.
- `inboundRelaysRoute.test.js` — tenant scoping; `secret` never in `GET`; `http://` and private IPs rejected.

Frontend has no test runner; the page ships untested like every other page. Not
addressed here.

## Out of scope

- Group inbound relay (`participantPn` resolution).
- Multiple relays per tenant.
- Encryption at rest for `secret`.
- Repairing `queueService`'s dead `auditService` wiring (`queueService.js:381`).
- The `db/init.sql` ↔ `schemaService.js` DDL duplication.
- Declaring axios in `backend/package.json` to fix `messageSender.js`'s reliance on a transitive dep. Real, and a boot-failure risk, but a separate concern from this feature — the relay avoids it by using `fetch`.
- Any change to the outbound pipeline.

## Rollout

1. Ship schema + service + hook + API + page.
2. Configure petag.id's tenant via the dashboard.
3. End-to-end: petag issues `wa.me/<bot>?text=PETAG-VERIFY:<blob>` → user sends → verify the signed POST lands and the browser auto-logs-in.
4. Watch the Timeline page for `warning`-severity LID drops. A high rate means WhatsApp is addressing that population by LID and R2 needs a resolution strategy (out of scope today, deliberately).

## Coordination required with petag.id

Two items the counterpart repo must confirm — see
`docs/petag-integration-brief.md`:

1. **`message_id` is not `wamid.*`.** The integration doc's example shows `wamid.HBg…`, which is the official Cloud API format. Baileys reports a different shape (e.g. `3EB0C767D26B8C3F…`). It is stable and unique per message, so it satisfies idempotency — but a validator expecting a `wamid.` prefix would reject every relay.
2. **Bot number ownership.** petag builds `wa.me/<number>` against a specific ZYRON bot. If that bot is banned or replaced, petag's links break. Which bot serves as the verification number must be agreed and pinned.
