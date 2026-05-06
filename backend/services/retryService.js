const RETRY_DELAYS_SECONDS = [60, 300, 900];
const NON_RETRYABLE_PATTERNS = [
    'invalid group',
    'not a group',
    'bad target',
    'recipient not found'
];

function getRetryDelaySeconds(attemptCount) {
    const index = Math.max(0, attemptCount - 1);
    return RETRY_DELAYS_SECONDS[Math.min(index, RETRY_DELAYS_SECONDS.length - 1)];
}

function normalizeErrorMessage(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return error.message || String(error);
}

function isRetryableError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    if (!message) return true;
    return !NON_RETRYABLE_PATTERNS.some(pattern => message.includes(pattern));
}

function getNextJobStateAfterFailure({ attemptCount, maxAttempts, error }) {
    const retryable = isRetryableError(error);
    if (!retryable || attemptCount >= maxAttempts) {
        return { status: 'failed', delaySeconds: 0, final: true };
    }
    return {
        status: 'retrying',
        delaySeconds: getRetryDelaySeconds(attemptCount),
        final: false
    };
}

module.exports = {
    getRetryDelaySeconds,
    getNextJobStateAfterFailure,
    isRetryableError,
    normalizeErrorMessage
};
