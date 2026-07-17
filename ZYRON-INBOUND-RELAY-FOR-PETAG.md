# ZYRON Inbound Relay — As Built

**For:** the petag.id repo / its coding agent.
**From:** ZYRON (`zyron.haniffaiq.com`).
**Date:** 2026-07-17
**Status:** implemented on branch `feat/inbound-relay`, 12 commits, 251 backend tests passing. Not yet deployed.
**Responds to:** `zyron-inbound-integration.md` (petag's spec to ZYRON).

This describes what ZYRON **actually does**, verified against the shipped code — not what was designed. Where reality differs from petag's spec, it is called out. Build the petag side against this document.

---

## TL;DR — what petag must change or handle

1. **`message_id` is not `wamid.*`.** Do not validate that prefix.
2. **`text` arrives trimmed**, despite the spec saying "untrimmed". Harmless for a base64url blob, but do not assert byte-equality with leading/trailing whitespace.
3. **Some verifications will never arrive, by design** (LID senders). Your polling UI needs a timeout and a fallback.
4. **Return `403` only for signature mismatch.** ZYRON treats it as a circuit breaker.
5. **Your endpoint must not redirect.** ZYRON refuses redirects outright.
6. **Your endpoint must be a hostname, not an IP literal**, and must be `https`.
7. **The bot number must be pinned.** If it changes, every `wa.me` link you issued breaks.

Everything else matches the spec you wrote.

---

## The request ZYRON sends

Unchanged from your spec.

```
POST https://<your configured destination>
Content-Type: application/json
X-Zyron-Signature: <lowercase hex hmac-sha256 of the raw body, key = the shared secret>

{"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}
```

Field order is fixed and guaranteed by construction: `from`, `text`, `message_id`, `timestamp`.

| Field | As built |
|---|---|
| `from` | Sender's real phone number, canonical digits, no `+`, no leading `0`. Sourced **only** from the WhatsApp envelope (`key.senderPn`, falling back to `key.remoteJid`). Never from message content. |
| `text` | The message body **after trimming** — see Deviation 2. |
| `message_id` | Baileys' `message.key.id`, e.g. `3EB0C767D26B8C3F1A2B` — see Deviation 1. |
| `timestamp` | `message.messageTimestamp` as unix seconds; falls back to receive time if absent. |

ZYRON never decrypts, parses, or inspects the blob.

**No tenant field, by design.** On ZYRON's side this is a generic multi-tenant feature: each tenant configures its own destination URL and its own secret, so **the secret is the tenant identity**. You hold one secret and receive from one tenant. Nothing to do — noted so it doesn't look like an omission.

---

## Deviation 1 — `message_id` is not `wamid.*`

Your spec's example is `"message_id": "wamid.HBg..."`. That is Meta's official **Cloud API** format. ZYRON runs on Baileys (WhatsApp Web protocol), which produces a different shape:

```
3EB0C767D26B8C3F1A2B
```

It is stable and unique per received message, so it satisfies your stated idempotency requirement.

**Action:** treat `message_id` as an opaque string. Any regex or prefix check for `wamid.` rejects every relay. Size the column for an opaque token.

---

## Deviation 2 — `text` is trimmed

Your spec: *"`text` — the full message body, verbatim, including the `PETAG-VERIFY:` marker. Do not trim or alter the blob."*

ZYRON trims. `extractMessageText` (`backend/bots/commandHandler.js:35`) ends in `String(text).trim()`. It is pre-existing, shared with the bot-command path, and changing it for the relay alone would have been riskier than reporting it.

Verified end-to-end:

```
raw message text   : "  PETAG-VERIFY:blob123  "
what ZYRON sends   : "PETAG-VERIFY:blob123"
```

The blob itself is untouched — only surrounding whitespace is removed, and a `wa.me?text=` link produces none. In practice this is a non-event.

**Action:** none expected. Do not write a test asserting whitespace survives.

---

## Deviation 3 — some messages will never arrive (fail-closed on LID)

The most important item here, because it is invisible from your side and looks exactly like a network failure.

**Background.** WhatsApp is migrating to **LID** addressing for privacy. Under LID, the envelope identifies the sender by an opaque id (`12345@lid`) instead of their phone number (`628xxx@s.whatsapp.net`). Baileys 6.7.23 exposes `key.senderPn` carrying the real number *when WhatsApp provides it* — and it does not always provide it.

**What ZYRON does.** Reads `key.senderPn`, falls back to `key.remoteJid`, and accepts the value only if the JID server is `s.whatsapp.net` or `c.us`. If it can obtain **only** a LID, it does **not forward**. It writes an audit row (`inbound_relay_dropped`, severity `warning`) and stops.

**Why.** Your security requirement #1 is that `from` is the true sender. A LID is not a phone number. Sending it would either fail your comparison or, worse, be trusted as one. No relay is safer than a wrong `from`.

**Action for petag — this is the real work on your side:**

- Put a timeout on the browser polling flow. A bounded window, then a clear failure state.
- Offer a fallback path, or at minimum an actionable error instead of an infinite spinner.
- Do not treat "no webhook received" as a client bug or a ZYRON outage. **It is a defined outcome.**

**What we still don't know:** the real-world rate of LID-only senders. It depends on Meta's rollout for each user population, and ZYRON has not observed it live yet. It may be near zero today and rise later. Every drop is logged with `warning` severity to ZYRON's Timeline, so the rate becomes measurable the moment this runs. If it turns out material, resolving LID → number via a WhatsApp lookup is the next step on ZYRON's side; it is deliberately out of scope for v1 (it adds a round-trip per verification and can still fail, so a fail-closed branch is needed regardless).

---

## Deviation 4 — `403` is a circuit breaker, not an error code

ZYRON implements your spec literally.

| Your response | ZYRON does |
|---|---|
| `2xx` | Done. Sends the confirmation reply if one is configured. |
| `403` | **Stops immediately. One attempt only, no retry.** Writes `inbound_relay_rejected`, severity `error`. |
| Any other non-2xx | Retries. 3 attempts total, backoff 1s then 5s. |
| Network error / timeout (10s per attempt) | Retries, same policy. |
| Attempts exhausted | Writes `inbound_relay_failed`, severity `error`. |

**Action:** reserve `403` **exclusively** for HMAC signature mismatch. If you return `403` for anything else — an unknown blob, an expired login attempt, a rate limit, a generic auth middleware, a WAF rule — ZYRON concludes the shared secret is broken, stops retrying, and raises an alert.

Use `200` for "ignored but known" (your spec already says this). Use other `4xx` or `5xx` for genuine transient problems you want retried.

**Corollary:** put the signature check **before** any generic auth middleware on that route, so a framework-level `403` can never be mistaken for a signature rejection.

---

## Deviation 5 — your endpoint must not redirect

ZYRON sends with `redirect: 'error'`. A `301/302/307/308` is refused, not followed.

**Why:** ZYRON validates the destination URL when it is saved. A redirect hands back a *second* URL that never passes through that validation. Node's fetch preserves method, headers and body across 307/308, so a followed redirect would carry the signed payload to an unvalidated address — including `127.0.0.1`, since ZYRON's production pod runs every service on a shared network namespace. The `https` requirement would be lost in the same hop. This was found in review and closed.

A refused redirect surfaces as `fetch failed: unexpected redirect` in ZYRON's Timeline, and burns all 3 attempts.

**Action:** point the configured URL directly at the handler. No redirects — not from `http`→`https`, not from apex→`www`, not from a load balancer. Verify with `curl -i` that your endpoint returns `200` on the exact URL given to ZYRON, not a `3xx`.

---

## Deviation 6 — destination must be an https hostname, not an IP

ZYRON's save-time validation (`backend/utils/relayUrl.js`) requires:

- scheme `https`
- a **hostname** — every IP literal is rejected, v4 and v6, public or private
- not `localhost` or any `*.localhost` (including trailing-dot forms)

The IP-literal rule is blanket rather than a private-range denylist. An earlier version enumerated private ranges and was bypassable with `https://[::ffff:169.254.169.254]/x` — an IPv4 address in IPv6 syntax skips every IPv4 check. Rejecting all literals retires that whole class instead of chasing notations.

DNS rebinding is explicitly **not** defended against; that is a known, accepted limit.

**Action:** give ZYRON something like `https://api.petag.id/webhooks/zyron`. A raw IP will be refused at save time.

---

## Deviation 7 — pin the bot number

You build `wa.me/<WA_BOT_NUMBER>` links against a specific WhatsApp account connected to ZYRON.

ZYRON runs on Baileys — **unofficial WhatsApp Web**, not the official Business API. Bot numbers can be banned or need replacing. When that happens, every `wa.me` link already in a user's hands points at a dead number.

**Action:**
- Agree with ZYRON which bot is the verification number, and pin it.
- Make `WA_BOT_NUMBER` runtime config, not a value that needs a deploy to change.
- Assume it will change at least once.

---

## HMAC — verify over raw bytes

Your spec already says this. Restating because it is the most common way this integration breaks, and because it constrains **your framework choice**.

**The trap:** if your framework parses the JSON body and you then re-serialize it to compute the HMAC, key order or spacing may differ from what ZYRON hashed, and every signature fails.

Demonstration — identical fields, different key order, same secret:

```
body A: {"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}
sig  A: a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e

body B: {"text":"PETAG-VERIFY:AbCdEf0123456789","from":"6281234567890","timestamp":1752600000,"message_id":"3EB0C767D26B8C3F1A2B"}
sig  B: 3661f7d76d708072229a951959ed2b812282a77a3ccecbb91e48dd0aa0512bf4
```

Completely different. **Capture the raw request body before parsing.** In Express: `express.raw({ type: 'application/json' })` on this route, or a `verify` callback that stashes the buffer. Most frameworks have an equivalent.

ZYRON serializes once, hashes those exact bytes, and sends those exact bytes. This is pinned by a test (`backend/tests/relaySignature.test.js`), so the vector below cannot drift from the implementation without the build failing.

### Test vector

Verify your implementation against this before touching the live secret:

```
secret    : test-secret-do-not-use-in-prod
raw body  : {"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}
byte len  : 122
signature : a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e
```

If `HMAC_SHA256(secret, raw_body)` in your language does not produce that hex, fix it before going live.

Use a **constant-time** comparison (`crypto.timingSafeEqual` or equivalent), not `===`.

---

## Delivery semantics

- **At-least-once.** ZYRON may deliver the same `message_id` more than once — for example, a retry after a timeout where your side actually succeeded. Your spec says you are idempotent on `message_id`; this design depends on it. **Please confirm idempotency is enforced by a unique constraint on `message_id`, not a read-then-write check** — the latter races under concurrent duplicate POSTs.
- **Messages sent while the bot was offline still arrive.** If a user sends a verification while ZYRON's bot is disconnected, WhatsApp delivers it in a batch on reconnect and ZYRON relays it then. It may arrive seconds or minutes late. Your login attempt may already have expired — return `200` (ignored-but-known) for those, not an error, or ZYRON retries pointlessly.
- **Respond fast.** Each attempt times out at **10 seconds**. A slow response burns a retry and delays the user's login. Verify the signature and ack; do heavy work after.
- **Ordering is not guaranteed.** Do not assume relays arrive in `timestamp` order.

---

## What ZYRON relays, precisely

Only a message meeting **all** of these:

1. Received on a bot socket belonging to the configured tenant. (This is how ZYRON knows the tenant — it is envelope-level and not client-controllable.)
2. **A direct message.** Group messages are never relayed, at all.
3. Not sent by the bot itself.
4. Text begins with the tenant's configured marker (`PETAG-VERIFY:`), after trimming.
5. The sender's real phone number is resolvable (see Deviation 3).

Anything else is ignored silently — normal chatter costs a string comparison and is never forwarded.

**Marker constraint:** a marker cannot begin with `!`. That prefix is reserved for bot commands and such a message would take the command path and never reach the relay. ZYRON rejects that at save time rather than letting it fail silently.

---

## Sender truthfulness — how ZYRON satisfies requirement #1

For your review, since your entire trust model rests on this.

`from` is derived **only** from the WhatsApp message envelope (`key.senderPn` / `key.remoteJid`) — what the WhatsApp server told the bot, not anything the sender can set. It never comes from message content, and there is no code path where a value from the blob or the text can reach the `from` field.

Which tenant a message belongs to is determined by **which bot socket received it** — also envelope-level, also not client-controllable.

Group messages are not relayed at all, which removes group-sender resolution rather than leaving it as a weaker second path.

---

## Confirmation reply

If configured, ZYRON replies in-chat **only after your endpoint returns 2xx**. The text is per-tenant configuration, not hardcoded — your example text names petag.id, which would leak into other tenants' messages if it were a constant.

Your reasoning that this is ban-safe is **correct** and worth recording: the user messaged first, so it is an in-session reply, not a cold outbound message. It carries none of the ban risk that ZYRON's outbound throttling exists to manage.

It is cosmetic — your browser-polling flow does not depend on it.

---

## Config exchange checklist

| Item | Owner | Notes |
|---|---|---|
| Destination URL | petag | e.g. `https://api.petag.id/webhooks/zyron`. Must be **https**, must be a **hostname**, must **not redirect**. |
| Shared secret | agreed out-of-band | Identical both sides. Strong random. Never logged, never committed, never in a ticket. Stored plaintext on ZYRON's side by necessity — HMAC is symmetric, so the value is needed to sign and cannot be hashed. |
| Marker | agreed | `PETAG-VERIFY:`. Configuration on ZYRON, not a constant. Max 64 chars. Cannot start with `!`. |
| Bot WhatsApp number | ZYRON | Pin it. See Deviation 7. |
| Confirmation reply text | petag supplies, ZYRON configures | Optional. Empty = disabled. |

---

## End-to-end check

1. petag issues `wa.me/<bot>?text=PETAG-VERIFY:<blob>`; the user taps and sends.
2. ZYRON receives it, resolves the true sender, POSTs the signed payload.
3. petag verifies the signature **over the raw body**, decrypts the blob, confirms the sender number matches the claimed number, marks the login verified.
4. The user's browser (polling) auto-logs-in.

Beyond the happy path, add to your test matrix:

- **Tampered body** → you return `403` → ZYRON alerts and does not retry.
- **Duplicate `message_id`** delivered twice concurrently → exactly one verification, no error.
- **`from` does not match the number inside the blob** → login rejected.
- **No webhook ever arrives** (the LID case) → your UI times out cleanly with an actionable message.
- **Your endpoint 307s** → confirm it does not, because ZYRON will refuse it.

---

## Questions back to petag

1. Do you validate `message_id` format anywhere? (Remove it — Deviation 1.)
2. Does any middleware on that route return `403` for non-signature reasons? (Deviation 4.)
3. What is your polling timeout today, and what does the user see when it expires? (Deviation 3 — the one that needs real work.)
4. Is idempotency a unique constraint on `message_id`, or a read-then-write check?
5. Does your endpoint sit behind anything that redirects — a load balancer, an apex→www rule, an http→https upgrade? (Deviation 5.)
6. Which bot number do you want pinned? (Deviation 7.)
