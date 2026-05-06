export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  jobs?: T;
  bots?: T;
  events?: T;
  meta?: Record<string, unknown> | null;
  limit?: number;
  offset?: number;
}

export interface OpsSummary {
  jobs: {
    queued?: number;
    sending?: number;
    retrying?: number;
    failed?: number;
    sent?: number;
    sent_today?: number;
    resolved?: number;
    ignored?: number;
    queue_depth?: number;
  };
  bots: {
    total?: number;
    online?: number;
    offline?: number;
    restarting?: number;
    reconnecting?: number;
    stale?: number;
  };
  recentEvents?: OperationalEvent[];
  generated_at?: string;
}

export interface BotHealth {
  botId?: string;
  bot_id?: string;
  status?: string | null;
  state?: string | null;
  tenantId?: string | null;
  tenant_id?: string | null;
  tenantName?: string | null;
  tenant_name?: string | null;
  lastSeenAt?: string | null;
  last_seen_at?: string | null;
  heartbeatAt?: string | null;
  heartbeat_at?: string | null;
  lastHeartbeatAt?: string | null;
  last_heartbeat_at?: string | null;
  successCount?: number | null;
  success_count?: number | null;
  failCount?: number | null;
  fail_count?: number | null;
  failureCount?: number | null;
  failure_count?: number | null;
  consecutive_failures?: number | null;
  activeJobCount?: number | null;
  active_job_count?: number | null;
  activeJobs?: number | null;
  active_jobs?: number | null;
  updated_at?: string | null;
}

export interface MessageJob {
  id: string;
  status?: string | null;
  attempts?: number | null;
  attempt_count?: number | null;
  maxAttempts?: number | null;
  max_attempts?: number | null;
  lastError?: string | null;
  last_error?: string | null;
  error?: string | null;
  nextAttemptAt?: string | null;
  next_attempt_at?: string | null;
  target?: string | string[] | null;
  target_id?: string | string[] | null;
  number?: string | string[] | null;
  recipient?: string | string[] | null;
  message?: string | null;
  payload?: {
    message?: string | null;
    target?: string | string[] | null;
    number?: string | string[] | null;
  } | null;
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
}

export interface OperationalEvent {
  id?: string | null;
  type?: string | null;
  eventType?: string | null;
  event_type?: string | null;
  severity?: string | null;
  status?: string | null;
  message?: string | null;
  details?: string | Record<string, unknown> | null;
  metadata?: string | Record<string, unknown> | null;
  botId?: string | null;
  bot_id?: string | null;
  jobId?: string | null;
  job_id?: string | null;
  entity_id?: string | null;
  tenantId?: string | null;
  tenant_id?: string | null;
  tenantName?: string | null;
  tenant_name?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  timestamp?: string | null;
}
