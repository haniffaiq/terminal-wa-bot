const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const { query } = require('../utils/db');
const { registerJob, cancelJob } = require('../utils/scheduler');

router.get('/', async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM scheduled_messages WHERE tenant_id = $1 ORDER BY created_at DESC',
            [req.user.tenantId]
        );
        res.json({ success: true, schedules: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { target_numbers, message, schedule_type, run_at, cron_expression } = req.body;

    if (!target_numbers || !Array.isArray(target_numbers) || target_numbers.length === 0) {
        return res.status(400).json({ success: false, error: 'target_numbers must be a non-empty array' });
    }
    if (!message) return res.status(400).json({ success: false, error: 'message is required' });
    if (schedule_type !== 'once' && schedule_type !== 'cron') {
        return res.status(400).json({ success: false, error: 'schedule_type must be "once" or "cron"' });
    }
    if (schedule_type === 'once' && (!run_at || new Date(run_at) <= new Date())) {
        return res.status(400).json({ success: false, error: 'run_at must be a future date' });
    }
    if (schedule_type === 'cron' && (!cron_expression || !cron.validate(cron_expression))) {
        return res.status(400).json({ success: false, error: 'Invalid cron expression' });
    }

    try {
        const result = await query(
            `INSERT INTO scheduled_messages (tenant_id, target_numbers, message, schedule_type, run_at, cron_expression)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.user.tenantId, JSON.stringify(target_numbers), message, schedule_type,
             schedule_type === 'once' ? run_at : null,
             schedule_type === 'cron' ? cron_expression : null]
        );
        const schedule = result.rows[0];
        registerJob(schedule);
        res.json({ success: true, schedule });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { target_numbers, message, schedule_type, run_at, cron_expression } = req.body;

    try {
        const existing = await query('SELECT * FROM scheduled_messages WHERE id = $1 AND tenant_id = $2', [id, req.user.tenantId]);
        if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Schedule not found' });

        if (schedule_type === 'cron' && cron_expression && !cron.validate(cron_expression)) {
            return res.status(400).json({ success: false, error: 'Invalid cron expression' });
        }

        const result = await query(
            `UPDATE scheduled_messages SET
                target_numbers = COALESCE($1, target_numbers),
                message = COALESCE($2, message),
                schedule_type = COALESCE($3, schedule_type),
                run_at = $4, cron_expression = $5
             WHERE id = $6 AND tenant_id = $7 RETURNING *`,
            [target_numbers ? JSON.stringify(target_numbers) : null, message, schedule_type,
             run_at || null, cron_expression || null, id, req.user.tenantId]
        );
        const schedule = result.rows[0];
        registerJob(schedule);
        res.json({ success: true, schedule });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await query(
            'DELETE FROM scheduled_messages WHERE id = $1 AND tenant_id = $2 RETURNING id',
            [id, req.user.tenantId]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Schedule not found' });
        cancelJob(id);
        res.json({ success: true, message: 'Schedule deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/:id/toggle', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await query(
            'UPDATE scheduled_messages SET is_active = NOT is_active WHERE id = $1 AND tenant_id = $2 RETURNING *',
            [id, req.user.tenantId]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Schedule not found' });
        const schedule = result.rows[0];
        if (schedule.is_active) registerJob(schedule); else cancelJob(id);
        res.json({ success: true, schedule });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
