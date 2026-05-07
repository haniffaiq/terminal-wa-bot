const { query } = require('./db');
const { hashPassword } = require('./auth');

async function seedSuperAdmin(retries = 10) {
    const username = process.env.SUPER_ADMIN_USER || 'admin';
    const password = process.env.SUPER_ADMIN_PASSWORD || 'admin123';

    for (let i = 0; i < retries; i++) {
        try {
            const existing = await query('SELECT id FROM users WHERE role = $1', ['super_admin']);
            const hash = await hashPassword(password);
            if (existing.rows.length > 0) {
                await query(
                    `UPDATE users
                     SET username = $1, password_hash = $2, is_active = true
                     WHERE id = $3`,
                    [username, hash, existing.rows[0].id]
                );
                console.log(`Super admin updated: ${username}`);
                return;
            }

            await query(
                `INSERT INTO users (username, password_hash, role, tenant_id)
                 VALUES ($1, $2, 'super_admin', NULL)`,
                [username, hash]
            );
            console.log(`Super admin seeded: ${username}`);
            return;
        } catch (err) {
            if (i < retries - 1) {
                console.log(`DB not ready, retrying seed in 3s... (${i + 1}/${retries})`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                console.error('Failed to seed super admin after retries:', err.message);
            }
        }
    }
}

module.exports = { seedSuperAdmin };
