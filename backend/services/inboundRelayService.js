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

    // Undici keeps the underlying socket open until the response body is
    // consumed or GC'd. This is a hot, retried path, so an un-drained body
    // per attempt accumulates open sockets. We never read the destination's
    // response — discard it as soon as we have the status.
    async function drain(res) {
        if (res && typeof res.arrayBuffer === 'function') {
            await res.arrayBuffer().catch(() => {});
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
                    // Save-time validation (relayUrl.js) rejects every IP literal, but
                    // that check runs only against the URL the tenant saved. A 307/308
                    // redirect hands back a *second* URL that never passes through it —
                    // Node's fetch preserves method/headers/body across redirects and
                    // would follow it straight past the guard (e.g. to 127.0.0.1 on the
                    // pod's shared netns), and the https requirement is lost in the same
                    // hop. A legitimate webhook endpoint does not redirect, so refuse
                    // rather than follow. fetch then rejects, and the retry loop below
                    // treats it like any other transport error.
                    redirect: 'error',
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });

                if (res.status === 403) {
                    await drain(res);
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

                if (res.ok) {
                    await drain(res);
                    return { ok: true, status: res.status };
                }

                await drain(res);
                lastError = `HTTP ${res.status}`;
            } catch (err) {
                // undici collapses every transport fault to "fetch failed" and puts the
                // real reason in .cause — a refused redirect, a DNS miss and a TLS error
                // are indistinguishable without it, though each needs a different fix.
                lastError = err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
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
