const assert = require('node:assert/strict');
const test = require('node:test');

const { createInboundRelayService } = require('../services/inboundRelayService');

const RELAY = {
    marker: 'PETAG-VERIFY:',
    destination_url: 'https://api.petag.id/webhooks/zyron',
    secret: 'test-secret-do-not-use-in-prod',
    reply_text: null
};
const MSG = {
    tenantId: 't1',
    relay: RELAY,
    from: '6281234567890',
    text: 'PETAG-VERIFY:AbCdEf0123456789',
    messageId: '3EB0C767D26B8C3F1A2B',
    timestamp: 1752600000
};

function okResponse(status = 200) {
    return { ok: status >= 200 && status < 300, status };
}

test('posts the signed body and reports success', async () => {
    const calls = [];
    const svc = createInboundRelayService({
        fetchFn: async (url, opts) => { calls.push({ url, opts }); return okResponse(200); },
        auditFn: async () => {}
    });

    const result = await svc.forward(MSG);

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.petag.id/webhooks/zyron');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(
        calls[0].opts.headers['X-Zyron-Signature'],
        'a91d6da679a6d41e5ae7a07712bf4b7e48558425ce67bd4cc06cc24a08ea1b2e'
    );
});

test('the body sent is a string, and it is the string that was signed', async () => {
    let sent = null;
    const svc = createInboundRelayService({
        fetchFn: async (url, opts) => { sent = opts.body; return okResponse(200); },
        auditFn: async () => {}
    });

    await svc.forward(MSG);

    assert.equal(typeof sent, 'string');
    assert.equal(sent, '{"from":"6281234567890","text":"PETAG-VERIFY:AbCdEf0123456789","message_id":"3EB0C767D26B8C3F1A2B","timestamp":1752600000}');
});

test('403 stops immediately without retrying and audits an error', async () => {
    let calls = 0;
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => { calls += 1; return okResponse(403); },
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    const result = await svc.forward(MSG);

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(calls, 1, 'a wrong shared secret cannot be fixed by retrying');
    assert.equal(events.length, 1);
    assert.equal(events[0].severity, 'error');
    assert.equal(events[0].eventType, 'inbound_relay_rejected');
});

test('a 500 retries up to maxAttempts then audits an error', async () => {
    let calls = 0;
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => { calls += 1; return okResponse(500); },
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    const result = await svc.forward(MSG);

    assert.equal(calls, 3);
    assert.equal(result.ok, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'inbound_relay_failed');
    assert.equal(events[0].severity, 'error');
});

test('a network error retries and a later success wins', async () => {
    let calls = 0;
    const svc = createInboundRelayService({
        fetchFn: async () => {
            calls += 1;
            if (calls < 3) throw new Error('ECONNRESET');
            return okResponse(200);
        },
        auditFn: async () => {},
        sleepFn: async () => {}
    });

    assert.equal((await svc.forward(MSG)).ok, true);
    assert.equal(calls, 3);
});

test('audit events never carry the blob or the secret', async () => {
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => okResponse(500),
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    await svc.forward(MSG);

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('AbCdEf0123456789'), 'blob must not be logged');
    assert.ok(!serialized.includes('test-secret-do-not-use-in-prod'), 'secret must not be logged');
});

test('audit events use a severity the DB CHECK constraint accepts', async () => {
    const events = [];
    const svc = createInboundRelayService({
        fetchFn: async () => okResponse(500),
        auditFn: async (e) => { events.push(e); },
        sleepFn: async () => {}
    });

    await svc.forward(MSG);
    await svc.logDroppedSender({ tenantId: 't1', messageId: 'abc' });

    for (const e of events) {
        assert.ok(['info', 'warning', 'error'].includes(e.severity), `bad severity: ${e.severity}`);
    }
});

test('an audit failure never breaks the relay result', async () => {
    const svc = createInboundRelayService({
        fetchFn: async () => okResponse(403),
        auditFn: async () => { throw new Error('db down'); },
        sleepFn: async () => {}
    });

    const result = await svc.forward(MSG);
    assert.equal(result.status, 403);
});

test('logDroppedSender records a warning', async () => {
    const events = [];
    const svc = createInboundRelayService({ auditFn: async (e) => { events.push(e); } });

    await svc.logDroppedSender({ tenantId: 't1', messageId: 'abc' });

    assert.equal(events.length, 1);
    assert.equal(events[0].severity, 'warning');
    assert.equal(events[0].eventType, 'inbound_relay_dropped');
    assert.equal(events[0].tenantId, 't1');
});
