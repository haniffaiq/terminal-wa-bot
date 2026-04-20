const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../utils/db');
const { getNextBotForGroup } = require('../bots/operationBot');

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
        if (number.length > 10) return res.status(400).json({ success: false, error: 'Maximum 10 recipients' });

        const results = [];
        for (const groupId of number) {
            const botSock = getNextBotForGroup(groupId, tenantId);
            if (!botSock || !botSock.sendMessage) {
                results.push({ number: groupId, success: false, error: 'No active bot' });
                continue;
            }
            try {
                await botSock.sendMessage(groupId, { text: message });
                results.push({ number: groupId, success: true });
            } catch (err) {
                results.push({ number: groupId, success: false, error: err.message });
            }
        }
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
