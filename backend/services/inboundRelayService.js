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
