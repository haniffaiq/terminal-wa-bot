CREATE TABLE IF NOT EXISTS message_stats (
    id SERIAL PRIMARY KEY,
    bot_name VARCHAR(100) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    hour SMALLINT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bot_name, date, hour)
);

CREATE TABLE IF NOT EXISTS failed_requests (
    id SERIAL PRIMARY KEY,
    transaction_id VARCHAR(100),
    target_numbers JSONB,
    message TEXT,
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    retried BOOLEAN DEFAULT FALSE,
    retried_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_date ON message_stats(date);
CREATE INDEX IF NOT EXISTS idx_stats_bot_date ON message_stats(bot_name, date);
CREATE INDEX IF NOT EXISTS idx_failed_retried ON failed_requests(retried);
