const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');

router.get('/', async (req, res) => {
    try {
        const result = await query('SELECT * FROM message_templates WHERE tenant_id = $1 ORDER BY name', [req.user.tenantId]);
        res.json({ success: true, templates: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ success: false, error: 'name and content are required' });

    try {
        const result = await query(
            'INSERT INTO message_templates (tenant_id, name, content) VALUES ($1, $2, $3) RETURNING *',
            [req.user.tenantId, name, content]
        );
        res.json({ success: true, template: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ success: false, error: 'Template name already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, content } = req.body;
    try {
        const existing = await query('SELECT * FROM message_templates WHERE id = $1', [id]);
        if (existing.rows.length === 0 || existing.rows[0].tenant_id !== req.user.tenantId) {
            return res.status(404).json({ success: false, error: 'Template not found' });
        }
        const result = await query(
            'UPDATE message_templates SET name = COALESCE($1, name), content = COALESCE($2, content) WHERE id = $3 AND tenant_id = $4 RETURNING *',
            [name, content, id, req.user.tenantId]
        );
        res.json({ success: true, template: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await query('DELETE FROM message_templates WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, req.user.tenantId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Template not found' });
        res.json({ success: true, message: 'Template deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
