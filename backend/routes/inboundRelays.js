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
