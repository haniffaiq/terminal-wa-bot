const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');
const { signToken, comparePassword } = require('../utils/auth');

router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    try {
        const result = await query(
            `SELECT u.id, u.username, u.password_hash, u.role, u.tenant_id, u.is_active,
                    t.brand_name, t.is_active as tenant_active
             FROM users u
             LEFT JOIN tenants t ON u.tenant_id = t.id
             WHERE u.username = $1`,
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.status(401).json({ success: false, error: 'Account is deactivated' });
        }

        if (user.role !== 'super_admin' && !user.tenant_active) {
            return res.status(401).json({ success: false, error: 'Tenant is deactivated' });
        }

        const valid = await comparePassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const token = signToken({
            userId: user.id,
            tenantId: user.tenant_id,
            role: user.role,
            brandName: user.brand_name || 'ZYRON',
        });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                tenantId: user.tenant_id,
                brandName: user.brand_name || 'ZYRON',
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

module.exports = router;
