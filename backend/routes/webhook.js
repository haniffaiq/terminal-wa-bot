const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../utils/db');
const queueService = require('../services/queueService');

function normalizeWebhookTarget(rawTarget) {
    let target = String(rawTarget || '').trim();
    if (!target) {
        throw new Error('Target number cannot be empty');
    }

    if (!target.includes('@')) {
        const digits = target.replace(/[^0-9-]/g, '');
        target = digits.length >= 18 ? `${digits}@g.us` : `${digits}@c.us`;
    }

    if (!target.endsWith('@g.us')) {
        throw new Error("Please don't send to personal number");
    }
    if (!/^[0-9-]+@g\.us$/.test(target)) {
        throw new Error('Target number is malformed');
    }

    return target;
}

router.get('/keys', async (req, res) => {
    try {
        const result = await query(
            'SELECT id, api_key, is_active, created_at FROM webhook_keys WHERE tenant_id = $1 AND is_active = TRUE',
            [req.user.tenantId]
        );
        const keys = result.rows.map(k => ({
            id: k.id,
            api_key_masked: '••••••••' + k.api_key.slice(-8),
            is_active: k.is_active,
            created_at: k.created_at
        }));
        res.json({ success: true, keys });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/keys', async (req, res) => {
    const apiKey = crypto.randomBytes(32).toString('hex');
    try {
        await query('UPDATE webhook_keys SET is_active = FALSE WHERE tenant_id = $1', [req.user.tenantId]);
        const result = await query(
            'INSERT INTO webhook_keys (tenant_id, api_key) VALUES ($1, $2) RETURNING *',
            [req.user.tenantId, apiKey]
        );
        res.json({ success: true, api_key: apiKey, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/keys/:id', async (req, res) => {
    try {
        await query('UPDATE webhook_keys SET is_active = FALSE WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user.tenantId]);
        res.json({ success: true, message: 'Key revoked' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/send', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, error: 'X-API-Key header required' });

    try {
        const keyResult = await query(
            'SELECT wk.tenant_id FROM webhook_keys wk JOIN tenants t ON wk.tenant_id = t.id WHERE wk.api_key = $1 AND wk.is_active = TRUE AND t.is_active = TRUE',
            [apiKey]
        );
        if (keyResult.rows.length === 0) return res.status(401).json({ success: false, error: 'Invalid or revoked API key' });

        const tenantId = keyResult.rows[0].tenant_id;
        let { number, message } = req.body;

        if (!number || !message) return res.status(400).json({ success: false, error: 'number and message are required' });
        if (!Array.isArray(number)) number = [number];
        number = [...new Set(number)];
        if (number.length > 10) return res.status(400).json({ success: false, error: 'Maximum 10 recipients' });
        let targets;
        try {
            targets = [...new Set(number.map(normalizeWebhookTarget))];
        } catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }

        const transactionId = `WH-${Date.now()}`;
        const jobs = await queueService.enqueueBulkMessageJobs({
            tenantId,
            source: 'webhook',
            type: 'text',
            targets,
            payload: { message, transactionId }
        });

        res.json({
            success: true,
            status: 'queued',
            job_ids: jobs.map(job => job.id),
            queued: jobs.length,
            transaction_id: transactionId
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
