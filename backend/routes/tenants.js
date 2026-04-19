const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');
const { hashPassword } = require('../utils/auth');
const { requireSuperAdmin } = require('../utils/midleware');

router.use(requireSuperAdmin);

router.get('/', async (req, res) => {
    try {
        const result = await query(`
            SELECT t.*,
                (SELECT COUNT(*) FROM users WHERE tenant_id = t.id) as user_count,
                (SELECT COUNT(*) FROM bot_status WHERE tenant_id = t.id) as bot_count
            FROM tenants t ORDER BY t.created_at DESC
        `);
        res.json({ success: true, tenants: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { name, brand_name, username, password } = req.body;

    if (!name || !brand_name || !username || !password) {
        return res.status(400).json({ success: false, error: 'name, brand_name, username, and password are required' });
    }

    try {
        const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }

        const tenantResult = await query(
            'INSERT INTO tenants (name, brand_name) VALUES ($1, $2) RETURNING *',
            [name, brand_name]
        );
        const tenant = tenantResult.rows[0];

        const hash = await hashPassword(password);
        await query(
            'INSERT INTO users (tenant_id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
            [tenant.id, username, hash, 'admin']
        );

        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, brand_name, is_active } = req.body;

    try {
        const result = await query(
            `UPDATE tenants SET
                name = COALESCE($1, name),
                brand_name = COALESCE($2, brand_name),
                is_active = COALESCE($3, is_active)
             WHERE id = $4 RETURNING *`,
            [name, brand_name, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tenant not found' });
        }

        res.json({ success: true, tenant: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await query('UPDATE tenants SET is_active = FALSE WHERE id = $1', [id]);
        res.json({ success: true, message: 'Tenant deactivated' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
