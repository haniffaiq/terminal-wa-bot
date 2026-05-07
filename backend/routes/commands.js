const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');

const SYSTEM_COMMANDS = ['!addbot', '!rst', '!rmbot', '!block', '!open', '!listblock', '!botstatus', '!restart', '!groupid', '!hi', '!ho', '!info', '!cmd', '!pmtcmt'];

function normalizeCommand(command) {
    return typeof command === 'string' ? command.trim().toLowerCase() : command;
}

router.get('/', async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM custom_commands WHERE tenant_id = $1 ORDER BY created_at',
            [req.user.tenantId]
        );
        res.json({ success: true, commands: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { command, response_template } = req.body;
    const normalizedCommand = normalizeCommand(command);

    if (!normalizedCommand || !response_template) {
        return res.status(400).json({ success: false, error: 'command and response_template are required' });
    }

    if (!normalizedCommand.startsWith('!')) {
        return res.status(400).json({ success: false, error: 'Command must start with !' });
    }

    if (SYSTEM_COMMANDS.includes(normalizedCommand)) {
        return res.status(400).json({ success: false, error: `"${normalizedCommand}" is a reserved system command` });
    }

    try {
        const result = await query(
            'INSERT INTO custom_commands (tenant_id, command, response_template) VALUES ($1, $2, $3) RETURNING *',
            [req.user.tenantId, normalizedCommand, response_template]
        );
        res.json({ success: true, command: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ success: false, error: 'Command already exists for this tenant' });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { command, response_template } = req.body;
    const normalizedCommand = normalizeCommand(command);

    try {
        const existing = await query('SELECT * FROM custom_commands WHERE id = $1', [id]);
        if (existing.rows.length === 0 || existing.rows[0].tenant_id !== req.user.tenantId) {
            return res.status(404).json({ success: false, error: 'Command not found' });
        }

        if (normalizedCommand !== undefined && normalizedCommand !== null) {
            if (!normalizedCommand) {
                return res.status(400).json({ success: false, error: 'Command cannot be empty' });
            }

            if (!normalizedCommand.startsWith('!')) {
                return res.status(400).json({ success: false, error: 'Command must start with !' });
            }

            if (SYSTEM_COMMANDS.includes(normalizedCommand)) {
                return res.status(400).json({ success: false, error: `"${normalizedCommand}" is a reserved system command` });
            }
        }

        const result = await query(
            `UPDATE custom_commands SET
                command = COALESCE($1, command),
                response_template = COALESCE($2, response_template)
             WHERE id = $3 AND tenant_id = $4 RETURNING *`,
            [normalizedCommand, response_template, id, req.user.tenantId]
        );
        res.json({ success: true, command: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await query(
            'DELETE FROM custom_commands WHERE id = $1 AND tenant_id = $2 RETURNING id',
            [id, req.user.tenantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Command not found' });
        }

        res.json({ success: true, message: 'Command deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.__normalizeCommandForTests = normalizeCommand;

module.exports = router;
