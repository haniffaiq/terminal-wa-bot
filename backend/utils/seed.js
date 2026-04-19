const { query } = require('./db');
const { hashPassword } = require('./auth');

async function seedSuperAdmin() {
    const username = process.env.SUPER_ADMIN_USER || 'admin';
    const password = process.env.SUPER_ADMIN_PASSWORD || 'admin123';

    try {
        const existing = await query('SELECT id FROM users WHERE role = $1', ['super_admin']);
        if (existing.rows.length > 0) return;

        const hash = await hashPassword(password);
        await query(
            `INSERT INTO users (username, password_hash, role, tenant_id)
             VALUES ($1, $2, 'super_admin', NULL)`,
            [username, hash]
        );
        console.log(`Super admin seeded: ${username}`);
    } catch (err) {
        console.error('Failed to seed super admin:', err.message);
    }
}

module.exports = { seedSuperAdmin };
