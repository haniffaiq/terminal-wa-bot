const assert = require('node:assert/strict');
const test = require('node:test');

const commandsRouter = require('../routes/commands');

test('normalizes custom command names before storage and matching', () => {
    assert.equal(commandsRouter.__normalizeCommandForTests('  !OWNER  '), '!owner');
    assert.equal(commandsRouter.__normalizeCommandForTests('!Owner extra'), '!owner extra');
});

test('preserves non-string command values for validation errors', () => {
    assert.equal(commandsRouter.__normalizeCommandForTests(undefined), undefined);
    assert.equal(commandsRouter.__normalizeCommandForTests(null), null);
});
