# ZYRON → petag.id — Inbound Relay Integration Brief

**For:** whoever builds the petag.id side of the inbound WhatsApp verification flow.
**From:** ZYRON (`zyron.haniffaiq.com`).
**Date:** 2026-07-16
**Status:** ZYRON design approved, implementation pending.
**Responds to:** `zyron-inbound-integration.md` (petag's spec to ZYRON).

---

## TL;DR

ZYRON is implementing your spec. **The wire contract is unchanged** — same URL,
same headers, same body, same field rules. Build to your own document.

Four things are worth your attention before you finalize:

1. `message_id` will **not** match `wamid.*`. Do not validate that prefix.
2. Some legitimate users' messages will **never reach you**, by design. Your UI needs a timeout path.
3. Return `403` **only** for signature mismatch. ZYRON treats `403` as "stop and alert".
4. The bot number must be pinned and agreed. If it changes, every `wa.me` link you issued breaks.

Details below.

---

## What ZYRON sends

Exactly what you specified. On every inbound WhatsApp message whose text begins
with the configured marker:

```
POST https://<PETAG_API_BASE>/webhooks/zyron
Content-Type: application/json
X-Zyron-Signature: <lowercase hex hmac-sha256 of the raw body, key = ZYRON_INBOUND_SECRET>

{
  "from": "6281234567890",
  "text": "PETAG-VERIFY:AbCdEf...base64url-blob...",
  "message_id": "3EB0C767D26B8C3F1A2B",
  "timestamp": 1752600000
}
```

- `from` — the true WhatsApp sender, canonical digits, no `+`, no leading `0`. Sourced from the WhatsApp message envelope only, never from message content. See "Sender truthfulness" below.
- `text` — full body verbatim, marker included, untrimmed.
- `message_id` — WhatsApp's message id. Stable and unique per message. **See deviation #1.**
- `timestamp` — unix seconds.

ZYRON does not decrypt, parse, or interpret the blob. You own the AES-256-GCM
key; ZYRON never sees plaintext.

There is **no tenant field in the body**, matching your spec. This is correct
and intentional: on the ZYRON side this is a generic multi-tenant feature where
each tenant configures its own destination URL and its own secret, so **the
secret is the tenant identity**. You hold one secret and receive from one
tenant. Nothing for you to do here — noted so it doesn't look like an omission.

---

## Deviation 1 — `message_id` is not `wamid.*`

**Your spec's example:** `"message_id": "wamid.HBg..."`

`wamid.*` is the identifier format of Meta's official **WhatsApp Cloud API**.
ZYRON runs on Baileys (WhatsApp Web protocol), which reports a different shape:

```
3EB0C767D26B8C3F1A2B
```

It is stable and unique per received message, so it fully satisfies your stated
requirement ("petag.id uses it for idempotency; it must be stable and unique per
received message").

**Action for petag:** treat `message_id` as an opaque string. Do not regex or
validate a `wamid.` prefix — if you do, every relay is rejected. Size your
column for an opaque token, not a fixed format.

---

## Deviation 2 — some messages will never arrive (fail-closed on LID)

This is the most important item in this document, because it is invisible from
your side and looks identical to a network failure.

**Background.** WhatsApp is migrating to **LID** (LinkedID) addressing for
privacy. Under LID, the message envelope identifies the sender by an opaque id
(`12345@lid`) instead of their phone number (`628xxx@s.whatsapp.net`). Baileys
6.7.23 exposes both: `key.senderPn` carries the phone number *when WhatsApp
provides it*, and it is not always provided.

**ZYRON's behavior.** ZYRON reads `key.senderPn`, falling back to the phone-number
JID. If it can obtain **only** a LID, it will **not forward the message**. It
logs the drop and stops.

**Why.** Your security requirement #1 is that `from` must be the true sender —
the whole login flow trusts it. A LID is not a phone number. Sending it would
either fail your comparison anyway, or, worse, be silently trusted as one. ZYRON
fails closed: no relay is safer than a wrong `from`.

**Action for petag.** A verification attempt can legitimately never arrive. Your
browser-polling UI must not poll forever:

- Add a timeout to the polling flow (a bounded window, then a clear failure state).
- Offer a fallback — a different verification path, or at minimum an actionable error rather than an infinite spinner.
- Do not treat "no webhook received" as a client bug or a ZYRON outage. It is a defined outcome.

**What we don't yet know:** the real-world rate of LID-only senders. It depends
on Meta's rollout state for each user population, and ZYRON has not observed it
live. It may be near zero today and rise later. ZYRON will log every drop with
`warning` severity to its Timeline, so the rate is measurable once running.

If the rate turns out to be material, resolving LID → phone number via a
WhatsApp lookup is the next step on ZYRON's side. It is deliberately out of
scope for v1 (it adds a WhatsApp round-trip per verification and is not
guaranteed to resolve, so a fail-closed branch is needed regardless).

---

## Deviation 3 — `403` is a circuit breaker, not an error code

Your spec: *"petag.id responds `200 { "received": true }` for accepted/ignored-but-known
messages, and `403` for a bad signature. Do not retry on `403` (means the secret
is misconfigured — alert instead)."*

ZYRON implements this literally:

| Your response | ZYRON does |
|---|---|
| `200` | Done. Sends the optional confirmation reply (if configured). |
| `403` | **Stops immediately. No retry.** Raises an `error`-severity alert. |
| Any other non-2xx, network error, timeout | Retries with backoff, 3 attempts total. |
| Attempts exhausted | Gives up. Raises an `error`-severity alert. |

**Action for petag:** reserve `403` **exclusively** for HMAC signature mismatch.
If you return `403` for anything else — an unknown blob, an expired login
attempt, a rate limit, a generic auth middleware, a WAF rule — ZYRON will
conclude the shared secret is broken, stop retrying, and page a human. Use `200`
for "ignored but known" (your spec already says this) and `4xx`-other or `5xx`
for genuine transient problems you want retried.

Corollary: put the signature check **before** any generic auth middleware on
that route, so a framework-level `403` can never be mistaken for a signature
rejection.

---

## Deviation 4 — pin the bot number

You build `wa.me/<WA_BOT_NUMBER>` links. That number is a specific WhatsApp
account connected to ZYRON.

ZYRON runs on Baileys, i.e. **unofficial WhatsApp Web**, not the official
Business API. Bot numbers can be banned or need replacement. When that happens,
every `wa.me` link already issued to a user points at a dead number.

**Action for petag:**

- Agree with ZYRON which bot is the verification number, and pin it.
- Do not hardcode it in a way that requires a deploy to change — make `WA_BOT_NUMBER` runtime config.
- Assume it will change at least once.

---

## Sender truthfulness — how ZYRON satisfies requirement #1

For your review, since your whole trust model rests on this.

`from` is derived **only** from the WhatsApp message envelope
(`key.senderPn` / `key.remoteJid`), never from message content, and never from
anything the client controls. The JID is what the WhatsApp server told the bot,
not something the sender can set.

Which ZYRON tenant a message belongs to is determined by **which bot socket
received it** — also envelope-level, also not client-controllable. There is no
path where a value from the blob or the message text can reach the `from` field.

Group messages are **not relayed at all**. Only direct messages to the bot.
This removes the group-sender resolution path entirely rather than leaving it
as a weaker second code path.

---

## HMAC — verify over raw bytes, not a re-serialized object

Your spec already says this (*"petag.id recomputes the HMAC over the raw body"*).
Restating because it is the single most common way this integration breaks, and
because it constrains **your** framework choice.

**The trap:** if you let your framework parse the JSON body and then
re-serialize it to compute the HMAC, key order and formatting may differ from
what ZYRON hashed, and every signature fails.

Demonstration — identical fields, different key order, same secret:

```
body A: {"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}
sig  A: a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e

body B: {"text":"PETAG-VERIFY:AbCdEf0123456789","from":"6281234567890","timestamp":1752600000,"message_id":"3EB0C767D26B8C3F1A2B"}
sig  B: 3661f7d76d708072229a951959ed2b812282a77a3ccecbb91e48dd0aa0512bf4
```

Completely different signatures. Capture the **raw request body** before parsing.
In Express that means `express.raw({ type: 'application/json' })` on this route
or a `verify` callback stashing the buffer; most frameworks have an equivalent.

ZYRON serializes once, hashes those exact bytes, and sends those exact bytes.

### Test vector

Verify your implementation against this before integrating:

```
secret    : test-secret-do-not-use-in-prod
raw body  : {"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}
byte len  : 122
signature : a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e
```

If `HMAC_SHA256(secret, raw_body)` in your language does not produce that hex,
fix it before touching the live secret.

Use a **constant-time** comparison (`crypto.timingSafeEqual` or equivalent) for
the signature check, not `===`.

---

## Delivery semantics

- **At-least-once.** ZYRON may deliver the same `message_id` more than once — on retry after a timeout where your side actually succeeded, for example. Your spec says you are idempotent on `message_id`; this design relies on that. Please confirm idempotency is keyed on `message_id` and survives concurrent duplicate POSTs (unique constraint, not a read-then-write check).
- **Respond fast.** ZYRON's POST has a timeout; a slow response burns a retry attempt and delays the user's login. Do the signature check and enqueue/ack, don't do heavy work inline.
- **Ordering is not guaranteed.** Do not assume relays arrive in `timestamp` order.

---

## Confirmation reply

ZYRON will optionally reply in-chat after you return `200` (per §4 of your spec).
The text is per-tenant configuration on ZYRON's side, not hardcoded — your
example text names petag.id, which would leak into other tenants' messages if
hardcoded.

Your reasoning that this is ban-safe is **correct** and worth recording: the
user messaged first, so it is an in-session reply, not a cold outbound message.
It carries none of the ban risk that ZYRON's outbound throttling exists to
manage.

It is sent **only** after a `200`, and it is cosmetic — your browser-polling flow
does not depend on it.

---

## Config exchange checklist

| Item | Owner | Notes |
|---|---|---|
| `PETAG_API_BASE` | petag | e.g. `https://api.petag.id`. Must be **https** — ZYRON rejects `http` and private/loopback addresses at config time. |
| `ZYRON_INBOUND_SECRET` | agreed out-of-band | Identical both sides. Strong random. Never logged, never committed, never in a ticket. |
| Marker | agreed | `PETAG-VERIFY:` — configuration on ZYRON's side, not a constant. |
| `WA_BOT_NUMBER` | ZYRON | Pin it. See deviation #4. |
| Confirmation reply text | petag supplies, ZYRON configures | Optional. Empty = disabled. |

---

## End-to-end check

1. petag issues `wa.me/<bot>?text=PETAG-VERIFY:<blob>`; user taps and sends.
2. ZYRON receives, resolves the true sender, POSTs the signed payload to `/webhooks/zyron`.
3. petag verifies the signature over the raw body, decrypts the blob, confirms the sender number matches the claimed number, marks the login verified.
4. The user's browser (polling) auto-logs-in.

Add to your test matrix, beyond the happy path:

- Tampered body → your side returns `403` → ZYRON alerts and does not retry.
- Duplicate `message_id` delivered twice → exactly one verification, no error.
- `from` does not match the number claimed inside the blob → login rejected.
- **No webhook ever arrives** (the LID case) → your UI times out cleanly with an actionable message.

---

## Questions back to petag

1. Do you validate `message_id` format anywhere? (If yes, remove it — deviation #1.)
2. Is `403` currently returned by any middleware on that route for non-signature reasons? (Deviation #3.)
3. What is your polling timeout today, and what does the user see when it expires? (Deviation #2.)
4. Is idempotency enforced by a unique constraint on `message_id`, or a read-then-write check? (The latter races under duplicate delivery.)
5. Which bot number do you want pinned as the verification number? (Deviation #4.)
