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
