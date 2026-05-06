-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    brand_name VARCHAR(50) NOT NULL,
    admin_bot_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Custom commands per tenant
CREATE TABLE IF NOT EXISTS custom_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    command VARCHAR(50) NOT NULL,
    response_template TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, command)
);

-- Bot status (replaces file-based bot_status.json)
CREATE TABLE IF NOT EXISTS bot_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    bot_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'close',
    is_admin_bot BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, bot_id)
);

-- Message stats (add tenant_id)
CREATE TABLE IF NOT EXISTS message_stats (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id),
    bot_name VARCHAR(100) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    hour SMALLINT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tenant_id, bot_name, date, hour)
);

-- Failed requests (add tenant_id)
CREATE TABLE IF NOT EXISTS failed_requests (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id),
    transaction_id VARCHAR(100),
    target_numbers JSONB,
    message TEXT,
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    retried BOOLEAN DEFAULT FALSE,
    retried_at TIMESTAMP
);

-- Auth sessions (replaces file-based auth_sessions/)
CREATE TABLE IF NOT EXISTS auth_sessions (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(100) NOT NULL,
    bot_id VARCHAR(100) NOT NULL,
    key_name VARCHAR(255) NOT NULL,
    key_data TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, bot_id, key_name)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_lookup ON auth_sessions(tenant_id, bot_id);

-- Scheduled messages
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    target_numbers JSONB NOT NULL,
    message TEXT NOT NULL,
    schedule_type VARCHAR(10) NOT NULL,
    run_at TIMESTAMP,
    cron_expression VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    last_run_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Message templates
CREATE TABLE IF NOT EXISTS message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

-- Webhook keys
CREATE TABLE IF NOT EXISTS webhook_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    api_key VARCHAR(64) UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Message jobs
CREATE TABLE IF NOT EXISTS message_jobs (
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
);

-- Message job attempts
CREATE TABLE IF NOT EXISTS message_job_attempts (
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
);

-- Bot health
CREATE TABLE IF NOT EXISTS bot_health (
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
);

-- Operational events
CREATE TABLE IF NOT EXISTS operational_events (
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
);

-- Bot group routes
CREATE TABLE IF NOT EXISTS bot_group_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    group_id VARCHAR(100) NOT NULL,
    bot_id VARCHAR(100) NOT NULL,
    last_used_at TIMESTAMP DEFAULT NOW(),
    failure_count INTEGER DEFAULT 0,
    CONSTRAINT chk_bot_group_routes_failure_count CHECK (failure_count >= 0),
    UNIQUE(tenant_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tenant ON scheduled_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_active ON scheduled_messages(is_active);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON message_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_key ON webhook_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_keys(tenant_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_commands_tenant ON custom_commands(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bot_status_tenant ON bot_status(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stats_tenant ON message_stats(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stats_date ON message_stats(date);
CREATE INDEX IF NOT EXISTS idx_stats_bot_date ON message_stats(bot_name, date);
CREATE INDEX IF NOT EXISTS idx_failed_tenant ON failed_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_failed_retried ON failed_requests(retried);
CREATE INDEX IF NOT EXISTS idx_message_jobs_tenant ON message_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_message_jobs_status_next_attempt ON message_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_message_jobs_created_at ON message_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_message_jobs_target ON message_jobs(target_id);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON message_job_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_attempts_tenant ON message_job_attempts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bot_health_tenant_status ON bot_health(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_created ON operational_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_operational_events_type ON operational_events(event_type);
CREATE INDEX IF NOT EXISTS idx_bot_group_routes_tenant_group ON bot_group_routes(tenant_id, group_id);
