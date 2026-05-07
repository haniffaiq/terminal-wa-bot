const { query } = require('../utils/db');

const OPERATIONS_SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS message_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        source VARCHAR(30) NOT NULL,
        type VARCHAR(20) NOT NULL,
        target_id VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        priority SMALLINT DEFAULT 5,
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        next_attempt_at TIMESTAMP DEFAULT NOW(),
        locked_at TIMESTAMP,
        locked_by VARCHAR(100),
        last_error TEXT,
        selected_bot_id VARCHAR(100),
        response_time_seconds NUMERIC,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        sent_at TIMESTAMP,
        CONSTRAINT chk_message_jobs_source CHECK (source IN ('api', 'webhook', 'schedule', 'manual_retry')),
        CONSTRAINT chk_message_jobs_type CHECK (type IN ('text', 'media_upload', 'media_url')),
        CONSTRAINT chk_message_jobs_status CHECK (status IN ('queued', 'sending', 'sent', 'retrying', 'failed', 'resolved', 'ignored')),
        CONSTRAINT chk_message_jobs_priority CHECK (priority >= 0),
        CONSTRAINT chk_message_jobs_attempt_count CHECK (attempt_count >= 0),
        CONSTRAINT chk_message_jobs_max_attempts CHECK (max_attempts > 0),
        CONSTRAINT chk_message_jobs_response_time_seconds CHECK (response_time_seconds IS NULL OR response_time_seconds >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS message_job_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID NOT NULL REFERENCES message_jobs(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        bot_id VARCHAR(100),
        status VARCHAR(20) NOT NULL,
        error TEXT,
        started_at TIMESTAMP DEFAULT NOW(),
        finished_at TIMESTAMP,
        response_time_seconds NUMERIC,
        CONSTRAINT chk_message_job_attempts_attempt_number CHECK (attempt_number > 0),
        CONSTRAINT chk_message_job_attempts_status CHECK (status IN ('sending', 'sent', 'failed')),
        CONSTRAINT chk_message_job_attempts_response_time_seconds CHECK (response_time_seconds IS NULL OR response_time_seconds >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS bot_health (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        bot_id VARCHAR(100) NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'unknown',
        last_seen_at TIMESTAMP,
        last_reconnect_at TIMESTAMP,
        reconnect_count INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        cooldown_until TIMESTAMP,
        last_error TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT chk_bot_health_status CHECK (status IN ('online', 'offline', 'reconnecting', 'qr_required', 'cooldown', 'unknown')),
        CONSTRAINT chk_bot_health_reconnect_count CHECK (reconnect_count >= 0),
        CONSTRAINT chk_bot_health_consecutive_failures CHECK (consecutive_failures >= 0),
        UNIQUE(tenant_id, bot_id)
    )`,
    `CREATE TABLE IF NOT EXISTS operational_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor_type VARCHAR(30) NOT NULL DEFAULT 'system',
        actor_id VARCHAR(100),
        event_type VARCHAR(60) NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'info',
        entity_type VARCHAR(30),
        entity_id VARCHAR(100),
        message TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT chk_operational_events_actor_type CHECK (actor_type IN ('system', 'user', 'webhook', 'schedule', 'worker')),
        CONSTRAINT chk_operational_events_severity CHECK (severity IN ('info', 'warning', 'error'))
    )`,
    `CREATE TABLE IF NOT EXISTS bot_group_routes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        group_id VARCHAR(100) NOT NULL,
        bot_id VARCHAR(100) NOT NULL,
        last_used_at TIMESTAMP DEFAULT NOW(),
        failure_count INTEGER DEFAULT 0,
        CONSTRAINT chk_bot_group_routes_failure_count CHECK (failure_count >= 0),
        UNIQUE(tenant_id, group_id)
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        api_key VARCHAR(64) UNIQUE NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS idx_message_jobs_tenant ON message_jobs(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_message_jobs_status_next_attempt ON message_jobs(status, next_attempt_at)',
    'CREATE INDEX IF NOT EXISTS idx_message_jobs_created_at ON message_jobs(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_message_jobs_target ON message_jobs(target_id)',
    'CREATE INDEX IF NOT EXISTS idx_attempts_job ON message_job_attempts(job_id)',
    'CREATE INDEX IF NOT EXISTS idx_attempts_tenant ON message_job_attempts(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_bot_health_tenant_status ON bot_health(tenant_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_created ON operational_events(tenant_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_operational_events_type ON operational_events(event_type)',
    'CREATE INDEX IF NOT EXISTS idx_bot_group_routes_tenant_group ON bot_group_routes(tenant_id, group_id)',
    'CREATE INDEX IF NOT EXISTS idx_webhook_key ON webhook_keys(api_key)',
    'CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_keys(tenant_id)'
];

async function ensureOperationsSchema({ queryFn = query } = {}) {
    for (const statement of OPERATIONS_SCHEMA_STATEMENTS) {
        await queryFn(statement);
    }
}

module.exports = {
    ensureOperationsSchema
};
