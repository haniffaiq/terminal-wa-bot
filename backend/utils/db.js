const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'wabot',
    user: process.env.DB_USER || 'wabot',
    password: process.env.DB_PASSWORD || 'wabot123',
});

pool.on('error', (err) => {
    console.error('Unexpected DB pool error:', err.message);
});

async function query(text, params) {
    return pool.query(text, params);
}

module.exports = { pool, query };
