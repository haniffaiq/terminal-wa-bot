const cron = require('node-cron');
const { query } = require('./db');
const queueService = require('../services/queueService');

const jobs = {};

async function sendScheduledMessage(schedule) {
    const { id, tenant_id, target_numbers, message } = schedule;
    const targets = typeof target_numbers === 'string' ? JSON.parse(target_numbers) : target_numbers;

    for (const groupId of targets) {
        try {
            await queueService.enqueueMessageJob({
                tenantId: tenant_id,
                source: 'schedule',
                type: 'text',
                targetId: groupId,
                payload: {
                    message,
                    transactionId: `SCH-${id}-${Date.now()}`
                }
            });
        } catch (err) {
            console.error(`[Scheduler] Failed to queue ${groupId}:`, err.message);
        }
    }

    await query('UPDATE scheduled_messages SET last_run_at = NOW() WHERE id = $1', [id]);

    if (schedule.schedule_type === 'once') {
        await query('UPDATE scheduled_messages SET is_active = FALSE WHERE id = $1', [id]);
        delete jobs[id];
    }
}

function registerJob(schedule) {
    cancelJob(schedule.id);

    if (!schedule.is_active) return;

    if (schedule.schedule_type === 'once' && schedule.run_at) {
        const delay = new Date(schedule.run_at).getTime() - Date.now();
        if (delay <= 0) {
            sendScheduledMessage(schedule);
            return;
        }
        jobs[schedule.id] = setTimeout(() => sendScheduledMessage(schedule), delay);
    } else if (schedule.schedule_type === 'cron' && schedule.cron_expression) {
        if (!cron.validate(schedule.cron_expression)) {
            console.error(`[Scheduler] Invalid cron: ${schedule.cron_expression}`);
            return;
        }
        jobs[schedule.id] = cron.schedule(schedule.cron_expression, () => sendScheduledMessage(schedule));
    }
}

function cancelJob(scheduleId) {
    if (!jobs[scheduleId]) return;
    if (typeof jobs[scheduleId] === 'object' && jobs[scheduleId].stop) {
        jobs[scheduleId].stop();
    } else {
        clearTimeout(jobs[scheduleId]);
    }
    delete jobs[scheduleId];
}

async function initScheduler() {
    try {
        const result = await query('SELECT * FROM scheduled_messages WHERE is_active = TRUE');
        for (const schedule of result.rows) {
            registerJob(schedule);
        }
        console.log(`[Scheduler] Loaded ${result.rows.length} active schedules`);
    } catch (err) {
        console.error('[Scheduler] Init failed:', err.message);
    }
}

module.exports = { registerJob, cancelJob, initScheduler };
