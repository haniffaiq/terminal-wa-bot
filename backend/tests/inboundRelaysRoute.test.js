const assert = require('node:assert/strict');
const test = require('node:test');

const router = require('../routes/inboundRelays');

const getTargetTenantId = router._getTargetTenantId;
const buildRelayResponse = router._buildRelayResponse;
const resolveIsActive = router._resolveIsActive;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

test('a tenant admin is pinned to their own JWT tenant', () => {
    const req = { user: { role: 'admin', tenantId: TENANT_A }, query: { tenant_id: TENANT_B }, body: {} };
    assert.equal(getTargetTenantId(req), TENANT_A, 'a client-supplied tenant_id must never win');
});

test('a super admin must name a tenant explicitly', () => {
    const req = { user: { role: 'super_admin', tenantId: null }, query: {}, body: {} };
    assert.throws(() => getTargetTenantId(req), /tenant_id is required/);
});

test('a super admin can act on a named tenant', () => {
    const req = { user: { role: 'super_admin', tenantId: null }, query: { tenant_id: TENANT_B }, body: {} };
    assert.equal(getTargetTenantId(req), TENANT_B);
});

test('a super admin cannot name a non-uuid tenant', () => {
    const req = { user: { role: 'super_admin', tenantId: null }, query: { tenant_id: 'not-a-uuid' }, body: {} };
    assert.throws(() => getTargetTenantId(req), /must be a valid UUID/);
});

test('the response never carries the secret', () => {
    const response = buildRelayResponse({
        marker: 'PETAG-VERIFY:',
        destination_url: 'https://api.petag.id/webhooks/zyron',
        secret: 'super-secret-value',
        reply_text: 'ok',
        is_active: true
    });

    assert.equal(response.secret_set, true);
    assert.equal(response.secret, undefined);
    assert.ok(!JSON.stringify(response).includes('super-secret-value'));
});

test('the response reports a missing secret', () => {
    const response = buildRelayResponse({
        marker: 'X:', destination_url: 'https://a.b/c', secret: '', reply_text: null, is_active: true
    });
    assert.equal(response.secret_set, false);
});

test('a null row builds a null response', () => {
    assert.equal(buildRelayResponse(null), null);
});

test('is_active explicit true is used as-is', () => {
    assert.equal(resolveIsActive(true, { is_active: false }), true);
});

test('is_active explicit false is used as-is', () => {
    assert.equal(resolveIsActive(false, { is_active: true }), false);
});

test('is_active omitted with an existing active row stays active', () => {
    assert.equal(resolveIsActive(undefined, { is_active: true }), true);
});

test('is_active omitted with an existing disabled row stays disabled', () => {
    assert.equal(resolveIsActive(undefined, { is_active: false }), false);
});

test('is_active omitted with no existing row defaults to active', () => {
    assert.equal(resolveIsActive(undefined, undefined), true);
});

test('is_active junk value falls back to the existing row value', () => {
    assert.equal(resolveIsActive('nope', { is_active: false }), false);
});
