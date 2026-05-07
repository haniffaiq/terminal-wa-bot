const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildUsageCostSummary
} = require('../services/usageCostService');

test('buildUsageCostSummary uses utility pricing as the benchmark in rupiah', () => {
    const summary = buildUsageCostSummary({
        counts: {
            sentToday: 10,
            sentMonth: 100,
            sentTotal: 250
        },
        env: {
            USAGE_COST_USD_TO_IDR: '16000'
        },
        generatedAt: '2026-05-07T10:00:00.000Z'
    });

    const meta = summary.providers.find(provider => provider.id === 'meta_official_utility');
    const twilio = summary.providers.find(provider => provider.id === 'twilio_utility');
    const vonage = summary.providers.find(provider => provider.id === 'vonage_utility');

    assert.equal(summary.currency, 'IDR');
    assert.equal(summary.benchmark_provider_id, 'meta_official_utility');
    assert.deepEqual(summary.counts, {
        sent_today: 10,
        sent_month: 100,
        sent_total: 250
    });
    assert.equal(summary.current.rate_per_message, 0);
    assert.equal(meta.rate_per_message, 285.32);
    assert.equal(twilio.rate_per_message, 365.32);
    assert.equal(vonage.rate_per_message, 407.56);
    assert.equal(summary.benchmark.costs.month, 28532);
    assert.equal(summary.benchmark.savings.month, 28532);
    assert.equal(summary.generated_at, '2026-05-07T10:00:00.000Z');
});

test('buildUsageCostSummary allows env overrides for current and provider rates', () => {
    const summary = buildUsageCostSummary({
        counts: {
            sentToday: 2,
            sentMonth: 2,
            sentTotal: 2
        },
        env: {
            USAGE_COST_CURRENT_RATE_IDR: '25',
            USAGE_COST_META_UTILITY_RATE_IDR: '300',
            USAGE_COST_TWILIO_PLATFORM_FEE_USD: '0.006',
            USAGE_COST_USD_TO_IDR: '17000'
        }
    });

    const twilio = summary.providers.find(provider => provider.id === 'twilio_utility');

    assert.equal(summary.current.costs.today, 50);
    assert.equal(summary.benchmark.rate_per_message, 300);
    assert.equal(summary.benchmark.savings.today, 550);
    assert.equal(twilio.rate_per_message, 402);
    assert.equal(twilio.savings.today, 754);
});
