const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getRetryDelaySeconds,
    getNextJobStateAfterFailure,
    isRetryableError
} = require('../services/retryService');

test('retry delays use 1m, 5m, 15m policy', () => {
    assert.equal(getRetryDelaySeconds(1), 60);
    assert.equal(getRetryDelaySeconds(2), 300);
    assert.equal(getRetryDelaySeconds(3), 900);
    assert.equal(getRetryDelaySeconds(9), 900);
});

test('job retries before max attempts', () => {
    const state = getNextJobStateAfterFailure({
        attemptCount: 1,
        maxAttempts: 3,
        error: new Error('No active bot')
    });
    assert.equal(state.status, 'retrying');
    assert.equal(state.delaySeconds, 60);
    assert.equal(state.final, false);
});

test('job fails when max attempts reached', () => {
    const state = getNextJobStateAfterFailure({
        attemptCount: 3,
        maxAttempts: 3,
        error: new Error('No active bot')
    });
    assert.equal(state.status, 'failed');
    assert.equal(state.delaySeconds, 0);
    assert.equal(state.final, true);
});

test('invalid group style errors are not retryable', () => {
    assert.equal(isRetryableError(new Error('invalid group')), false);
    assert.equal(isRetryableError(new Error('No active bot')), true);
});
