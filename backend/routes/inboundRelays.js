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
 * A marker starting with '!' would save fine and then never relay: every bot
 * socket routes '!'-prefixed text down the command path
 * (`commandHandler.js`'s `!` gate) before the relay hook ever sees it, so
 * such a marker is permanently unreachable. That failure is invisible from
 * here — PUT would return 200 and the dashboard would show the relay
 * "Active" — so it must be rejected at save time instead.
 */
function validateMarker(marker) {
    if (typeof marker !== 'string' || !marker.trim()) {
        return { ok: false, error: 'marker is required' };
    }
    const trimmed = marker.trim();
    if (trimmed.length > MAX_MARKER_LENGTH) {
        return { ok: false, error: `marker must be at most ${MAX_MARKER_LENGTH} characters` };
    }
    if (trimmed.startsWith('!')) {
        return {
            ok: false,
            error: 'marker must not start with "!" — that prefix is reserved for bot commands and a message starting with it would never reach the relay'
        };
    }
    return { ok: true, marker: trimmed };
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

/**
 * Resolve the row's next `is_active` value in JS instead of leaning on SQL's
 * `COALESCE($n, TRUE)`. That expression lives in the INSERT ... VALUES list,
 * and on conflict `EXCLUDED.is_active` re-reads that *evaluated VALUES
 * expression* — not the row's current value in the table. So an omitted
 * `is_active` (bound as JS `undefined` -> SQL NULL) would COALESCE to TRUE
 * and silently flip a deliberately-disabled relay back on during an
 * unrelated edit (e.g. fixing a typo in `marker`). Resolving it here lets us
 * see the existing row and actually preserve it on omission.
 */
function resolveIsActive(bodyValue, existingRow) {
    if (bodyValue === true || bodyValue === false) return bodyValue;
    if (existingRow && (existingRow.is_active === true || existingRow.is_active === false)) {
        return existingRow.is_active;
    }
    return true;
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

        const markerCheck = validateMarker(marker);
        if (!markerCheck.ok) throw new BadRequestError(markerCheck.error);

        const urlCheck = validateRelayUrl(destinationUrl);
        if (!urlCheck.ok) throw new BadRequestError(urlCheck.error);

        const existing = await query('SELECT secret, is_active FROM inbound_relays WHERE tenant_id = $1', [tenantId]);
        // Omitting `secret` means "leave it alone", so the marker or reply text
        // can be edited without the operator re-pasting the shared secret.
        const nextSecret = (typeof secret === 'string' && secret.length > 0)
            ? secret
            : existing.rows[0]?.secret;

        if (!nextSecret) throw new BadRequestError('secret is required');

        const nextIsActive = resolveIsActive(isActive, existing.rows[0]);

        const result = await query(
            `INSERT INTO inbound_relays (tenant_id, marker, destination_url, secret, reply_text, is_active)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id) DO UPDATE SET
                marker = EXCLUDED.marker,
                destination_url = EXCLUDED.destination_url,
                secret = EXCLUDED.secret,
                reply_text = EXCLUDED.reply_text,
                is_active = EXCLUDED.is_active,
                updated_at = NOW()
             RETURNING marker, destination_url, secret, reply_text, is_active`,
            [tenantId, markerCheck.marker, urlCheck.url, nextSecret, replyText || null, nextIsActive]
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
router._resolveIsActive = resolveIsActive;
router._validateMarker = validateMarker;

module.exports = router;
