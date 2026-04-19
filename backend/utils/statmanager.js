const { query } = require('./db');

// Increment message count for a bot (upsert)
async function increment(botName) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hour = now.getHours();

    try {
        await query(
            `INSERT INTO message_stats (bot_name, date, hour, count)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (bot_name, date, hour)
             DO UPDATE SET count = message_stats.count + 1`,
            [botName, date, hour]
        );
    } catch (err) {
        console.error('Stats increment error:', err.message);
    }
}

// Get stats for a specific date — returns { "HH": { botName: count } }
async function getStatsByDate(date) {
    try {
        const result = await query(
            `SELECT hour, bot_name, count FROM message_stats WHERE date = $1 ORDER BY hour`,
            [date]
        );

        const stats = {};
        for (const row of result.rows) {
            const hourKey = String(row.hour).padStart(2, '0');
            if (!stats[hourKey]) stats[hourKey] = {};
            stats[hourKey][row.bot_name] = row.count;
        }
        return stats;
    } catch (err) {
        console.error('Stats query error:', err.message);
        return {};
    }
}

// flush is now a no-op since we write directly to DB
function flush() {}

module.exports = {
    increment,
    getStatsByDate,
    flush
};
