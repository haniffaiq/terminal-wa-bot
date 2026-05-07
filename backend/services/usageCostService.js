const DEFAULT_CURRENCY = 'IDR';
const DEFAULT_USD_TO_IDR = 16000;
const DEFAULT_CURRENT_RATE_IDR = 0;
const DEFAULT_META_UTILITY_RATE_IDR = 285.32;
const DEFAULT_META_MARKETING_RATE_IDR = 586.33;
const DEFAULT_TWILIO_PLATFORM_FEE_USD = 0.005;
const DEFAULT_BIRD_PLATFORM_FEE_USD = 0.005;
const DEFAULT_VONAGE_PLATFORM_FEE_USD = 0.00764;
const DEFAULT_BENCHMARK_PROVIDER_ID = 'meta_official_utility';

function parsePositiveNumber(value, fallback, { allowZero = true } = {}) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 0) return fallback;
    if (!allowZero && parsed === 0) return fallback;
    return parsed;
}

function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toCount(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildCostSet(counts, ratePerMessage) {
    return {
        today: roundMoney(counts.sent_today * ratePerMessage),
        month: roundMoney(counts.sent_month * ratePerMessage),
        total: roundMoney(counts.sent_total * ratePerMessage)
    };
}

function buildSavingsSet(providerCosts, currentCosts) {
    return {
        today: roundMoney(providerCosts.today - currentCosts.today),
        month: roundMoney(providerCosts.month - currentCosts.month),
        total: roundMoney(providerCosts.total - currentCosts.total)
    };
}

function buildProvider({ id, label, category, ratePerMessage, source, note }, counts, currentCosts) {
    const costs = buildCostSet(counts, ratePerMessage);
    return {
        id,
        label,
        category,
        rate_per_message: roundMoney(ratePerMessage),
        costs,
        savings: buildSavingsSet(costs, currentCosts),
        source,
        note
    };
}

function getUsageRates(env = process.env) {
    const usdToIdr = parsePositiveNumber(env.USAGE_COST_USD_TO_IDR, DEFAULT_USD_TO_IDR, { allowZero: false });
    const metaUtilityRateIdr = parsePositiveNumber(env.USAGE_COST_META_UTILITY_RATE_IDR, DEFAULT_META_UTILITY_RATE_IDR);
    const metaMarketingRateIdr = parsePositiveNumber(env.USAGE_COST_META_MARKETING_RATE_IDR, DEFAULT_META_MARKETING_RATE_IDR);

    return {
        currency: env.USAGE_COST_CURRENCY || DEFAULT_CURRENCY,
        usdToIdr,
        currentRateIdr: parsePositiveNumber(env.USAGE_COST_CURRENT_RATE_IDR, DEFAULT_CURRENT_RATE_IDR),
        metaUtilityRateIdr,
        metaMarketingRateIdr,
        twilioUtilityRateIdr: roundMoney(
            metaUtilityRateIdr
            + (parsePositiveNumber(env.USAGE_COST_TWILIO_PLATFORM_FEE_USD, DEFAULT_TWILIO_PLATFORM_FEE_USD) * usdToIdr)
        ),
        birdUtilityRateIdr: roundMoney(
            metaUtilityRateIdr
            + (parsePositiveNumber(env.USAGE_COST_BIRD_PLATFORM_FEE_USD, DEFAULT_BIRD_PLATFORM_FEE_USD) * usdToIdr)
        ),
        vonageUtilityRateIdr: roundMoney(
            metaUtilityRateIdr
            + (parsePositiveNumber(env.USAGE_COST_VONAGE_PLATFORM_FEE_USD, DEFAULT_VONAGE_PLATFORM_FEE_USD) * usdToIdr)
        ),
        benchmarkProviderId: env.USAGE_COST_BENCHMARK_PROVIDER_ID || DEFAULT_BENCHMARK_PROVIDER_ID
    };
}

function normalizeCounts(counts = {}) {
    return {
        sent_today: toCount(counts.sent_today ?? counts.sentToday),
        sent_month: toCount(counts.sent_month ?? counts.sentMonth),
        sent_total: toCount(counts.sent_total ?? counts.sentTotal)
    };
}

function buildUsageCostSummary({ counts, env = process.env, generatedAt = new Date().toISOString() }) {
    const normalizedCounts = normalizeCounts(counts);
    const rates = getUsageRates(env);
    const currentCosts = buildCostSet(normalizedCounts, rates.currentRateIdr);
    const current = {
        id: 'zyron_baileys',
        label: 'Zyron Bot',
        category: 'baileys',
        rate_per_message: roundMoney(rates.currentRateIdr),
        costs: currentCosts,
        note: 'Internal estimate. Infrastructure cost is not allocated per message unless USAGE_COST_CURRENT_RATE_IDR is set.'
    };

    const providers = [
        buildProvider({
            id: 'meta_official_utility',
            label: 'Meta Official API',
            category: 'utility',
            ratePerMessage: rates.metaUtilityRateIdr,
            source: 'https://whatsappbusiness.com/products/platform-pricing/',
            note: 'Utility template estimate for Indonesian recipients.'
        }, normalizedCounts, currentCosts),
        buildProvider({
            id: 'twilio_utility',
            label: 'Twilio WhatsApp',
            category: 'utility',
            ratePerMessage: rates.twilioUtilityRateIdr,
            source: 'https://www.twilio.com/en-us/whatsapp/pricing',
            note: 'Meta utility estimate plus Twilio per-message processing fee.'
        }, normalizedCounts, currentCosts),
        buildProvider({
            id: 'bird_utility',
            label: 'Bird WhatsApp',
            category: 'utility',
            ratePerMessage: rates.birdUtilityRateIdr,
            source: 'https://bird.com/en/pricing',
            note: 'Meta utility estimate plus Bird processing fee estimate.'
        }, normalizedCounts, currentCosts),
        buildProvider({
            id: 'vonage_utility',
            label: 'Vonage WhatsApp',
            category: 'utility',
            ratePerMessage: rates.vonageUtilityRateIdr,
            source: 'https://api.support.vonage.com/hc/en-us/articles/20773952146460-WhatsApp-Pricing-Vonage-Platform-Fees',
            note: 'Meta utility estimate plus Vonage platform fee estimate.'
        }, normalizedCounts, currentCosts),
        buildProvider({
            id: 'meta_official_marketing',
            label: 'Meta Official API',
            category: 'marketing',
            ratePerMessage: rates.metaMarketingRateIdr,
            source: 'https://whatsappbusiness.com/products/platform-pricing/',
            note: 'Marketing template reference, not the default benchmark.'
        }, normalizedCounts, currentCosts)
    ];

    const benchmark = providers.find(provider => provider.id === rates.benchmarkProviderId) || providers[0];

    return {
        currency: rates.currency,
        benchmark_provider_id: benchmark.id,
        benchmark_category: benchmark.category,
        counts: normalizedCounts,
        current,
        benchmark,
        providers,
        assumptions: [
            'Counts use message_jobs rows with status sent. Official providers usually bill delivered messages.',
            'Rates are estimates and can be overridden from environment variables.',
            'Official WhatsApp charges vary by recipient market, message category, volume tier, and customer-service/free-entry windows.'
        ],
        generated_at: generatedAt
    };
}

module.exports = {
    buildUsageCostSummary,
    getUsageRates,
    normalizeCounts
};
