const assert = require('node:assert/strict');
const test = require('node:test');

const webhookRoutes = require('../routes/webhook');

test('normalizeWebhookTarget accepts group ids and rejects personal numbers', () => {
    assert.equal(webhookRoutes._normalizeWebhookTarget('120363123456789012@g.us'), '120363123456789012@g.us');
    assert.equal(webhookRoutes._normalizeWebhookTarget('120363123456789012'), '120363123456789012@g.us');
    assert.throws(
        () => webhookRoutes._normalizeWebhookTarget('6281234567890'),
        /Please don't send to personal number/
    );
    assert.throws(
        () => webhookRoutes._normalizeWebhookTarget('not-a-group'),
        /Target number is malformed|Please don't send to personal number/
    );
});

test('buildWebhookKeyListResponse returns legacy single-key shape and key list shape', () => {
    const response = webhookRoutes._buildWebhookKeyListResponse([
        {
            id: 'key-1',
            api_key: 'abcdef1234567890',
            is_active: true,
            created_at: '2026-05-07T09:00:00.000Z'
        }
    ]);

    assert.equal(response.success, true);
    assert.equal(response.exists, true);
    assert.equal(response.id, 'key-1');
    assert.equal(response.masked_key, '••••••••34567890');
    assert.deepEqual(response.keys, [
        {
            id: 'key-1',
            api_key_masked: '••••••••34567890',
            masked_key: '••••••••34567890',
            is_active: true,
            created_at: '2026-05-07T09:00:00.000Z'
        }
    ]);
});

test('buildWebhookKeyListResponse handles tenants without active keys', () => {
    assert.deepEqual(webhookRoutes._buildWebhookKeyListResponse([]), {
        success: true,
        exists: false,
        id: null,
        masked_key: null,
        keys: []
    });
});

test('buildWebhookKeyCreateResponse exposes api_key and key for frontend compatibility', () => {
    assert.deepEqual(webhookRoutes._buildWebhookKeyCreateResponse({
        id: 'key-1',
        apiKey: 'secret-value'
    }), {
        success: true,
        id: 'key-1',
        api_key: 'secret-value',
        key: 'secret-value',
        masked_key: '••••••••et-value'
    });
});

test('extractWebhookApiKey supports x-api-key and bearer headers', () => {
    assert.equal(webhookRoutes._extractWebhookApiKey({ 'x-api-key': 'abc' }), 'abc');
    assert.equal(webhookRoutes._extractWebhookApiKey({ authorization: 'Bearer def' }), 'def');
    assert.equal(webhookRoutes._extractWebhookApiKey({ authorization: 'Token def' }), null);
    assert.equal(webhookRoutes._extractWebhookApiKey({}), null);
});
