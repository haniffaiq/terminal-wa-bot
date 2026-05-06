# Stability and Operations Upgrade Design

## Context

The application is a multi-tenant WhatsApp delivery gateway with a React dashboard, Node.js/Express API, PostgreSQL persistence, Baileys-based bot sessions, message templates, schedules, webhooks, tenant management, group tools, logs, statistics, and failed request handling.

The current delivery path sends messages directly inside API request handlers. This keeps the first version simple, but makes failures harder to recover from because in-flight requests can be lost on restart, retry behavior is limited, and operational state is spread across logs, bot status, statistics, and failed request rows.

## Goals

- Make message delivery durable across process restarts.
- Add automatic retry with attempt history and clear final states.
- Track bot health with meaningful operational statuses.
- Route messages through healthy bots using load, cooldown, and group affinity.
- Provide a human-readable operational timeline.
- Turn failed requests into an actionable support workflow.
- Preserve existing user-facing capabilities while changing delivery internals safely.

## Non-Goals

- No horizontal multi-instance locking beyond PostgreSQL row locking in this phase.
- No external queue system such as Redis, RabbitMQ, or SQS.
- No billing, usage limits, or plan enforcement.
- No WhatsApp personal-number delivery expansion.
- No full observability stack integration such as Prometheus or OpenTelemetry.

## Recommended Approach

Implement the upgrade as one staged package:

1. Add PostgreSQL schema and backend service foundations.
2. Move existing send flows onto a durable queue and worker.
3. Add health tracking, retry policy, smarter bot routing, and audit events.
4. Upgrade the dashboard with queue, bot health, failure inbox, and operational timeline views.

This keeps the project on the current Express/PostgreSQL architecture while fixing the core reliability gap first.

## Data Model

### `message_jobs`

Stores one durable delivery job per API/webhook/schedule request target.

Important columns:

- `id UUID PRIMARY KEY`
- `tenant_id UUID`
- `source VARCHAR(30)` with values such as `api`, `webhook`, `schedule`, `manual_retry`
- `type VARCHAR(20)` with values such as `text`, `media_upload`, `media_url`
- `target_id VARCHAR(100)`
- `payload JSONB`
- `status VARCHAR(20)` with values `queued`, `sending`, `sent`, `retrying`, `failed`, `resolved`, `ignored`
- `priority SMALLINT DEFAULT 5`
- `attempt_count INTEGER DEFAULT 0`
- `max_attempts INTEGER DEFAULT 3`
- `next_attempt_at TIMESTAMP DEFAULT NOW()`
- `locked_at TIMESTAMP`
- `locked_by VARCHAR(100)`
- `last_error TEXT`
- `selected_bot_id VARCHAR(100)`
- `response_time_seconds NUMERIC`
- `created_at TIMESTAMP DEFAULT NOW()`
- `updated_at TIMESTAMP DEFAULT NOW()`
- `sent_at TIMESTAMP`

### `message_job_attempts`

Stores every delivery attempt.

Important columns:

- `id UUID PRIMARY KEY`
- `job_id UUID REFERENCES message_jobs(id) ON DELETE CASCADE`
- `tenant_id UUID`
- `attempt_number INTEGER`
- `bot_id VARCHAR(100)`
- `status VARCHAR(20)` with values `sending`, `sent`, `failed`
- `error TEXT`
- `started_at TIMESTAMP DEFAULT NOW()`
- `finished_at TIMESTAMP`
- `response_time_seconds NUMERIC`

### `bot_health`

Stores the operational state of each bot.

Important columns:

- `id UUID PRIMARY KEY`
- `tenant_id UUID`
- `bot_id VARCHAR(100)`
- `status VARCHAR(30)` with values `online`, `offline`, `reconnecting`, `qr_required`, `cooldown`, `unknown`
- `last_seen_at TIMESTAMP`
- `last_reconnect_at TIMESTAMP`
- `reconnect_count INTEGER DEFAULT 0`
- `consecutive_failures INTEGER DEFAULT 0`
- `cooldown_until TIMESTAMP`
- `last_error TEXT`
- `updated_at TIMESTAMP DEFAULT NOW()`
- unique constraint on `(tenant_id, bot_id)`

### `operational_events`

Stores readable timeline events for support and debugging.

Important columns:

- `id UUID PRIMARY KEY`
- `tenant_id UUID`
- `actor_type VARCHAR(30)` with values such as `system`, `user`, `webhook`, `schedule`, `worker`
- `actor_id VARCHAR(100)`
- `event_type VARCHAR(60)`
- `severity VARCHAR(20)` with values `info`, `warning`, `error`
- `entity_type VARCHAR(30)`
- `entity_id VARCHAR(100)`
- `message TEXT`
- `metadata JSONB`
- `created_at TIMESTAMP DEFAULT NOW()`

### `bot_group_routes`

Stores sticky group-to-bot routing.

Important columns:

- `id UUID PRIMARY KEY`
- `tenant_id UUID`
- `group_id VARCHAR(100)`
- `bot_id VARCHAR(100)`
- `last_used_at TIMESTAMP DEFAULT NOW()`
- `failure_count INTEGER DEFAULT 0`
- unique constraint on `(tenant_id, group_id)`

## Backend Components

### `queueService`

Responsibilities:

- Convert incoming send requests into `message_jobs`.
- Normalize one job per target group.
- Store source metadata such as API, webhook, schedule, or retry.
- Return job identifiers to callers.

### `deliveryWorker`

Responsibilities:

- Poll `message_jobs` where status is `queued` or `retrying` and `next_attempt_at <= NOW()`.
- Lock rows with PostgreSQL `FOR UPDATE SKIP LOCKED`.
- Mark jobs as `sending`.
- Ask `routingService` for the best bot.
- Send the message using the existing Baileys send path.
- Write `message_job_attempts`.
- Mark jobs as `sent`, `retrying`, or `failed`.
- Emit `operational_events`.

### `retryService`

Responsibilities:

- Apply retry delays of 1 minute, 5 minutes, and 15 minutes by default.
- Stop retrying once `attempt_count >= max_attempts`.
- Keep the final failure reason on `message_jobs.last_error`.
- Allow manual retry to create a new queued attempt from a failed/resolved job.

### `botHealthService`

Responsibilities:

- Upsert health rows when bots connect, disconnect, error, reconnect, or require QR.
- Periodically mark bots offline if `last_seen_at` is stale.
- Trigger reconnect for eligible offline bots.
- Put bots into cooldown after repeated send failures.

### `routingService`

Responsibilities:

- Prefer the sticky bot for a group when it is healthy.
- Exclude offline, reconnecting, QR-required, or cooldown bots.
- Prefer bots with lower current queue/sending load.
- Fall back to another healthy bot when the sticky bot fails.
- Update `bot_group_routes` after successful delivery.

### `auditService`

Responsibilities:

- Centralize writes to `operational_events`.
- Use consistent event names and severity.
- Avoid relying on raw log parsing for dashboard workflows.

## API Changes

Existing routes remain available.

### Send Routes

`POST /api/send-message`, `POST /api/send-media`, `POST /api/send-media-from-url`, webhook sends, and scheduled sends will enqueue jobs instead of doing all delivery inline.

Default response:

```json
{
  "success": true,
  "status": "queued",
  "job_ids": ["uuid"],
  "queued": 1
}
```

The response no longer guarantees final WhatsApp delivery in the initial HTTP request. Final delivery status is available from the job/failure APIs.

### New Operations APIs

- `GET /api/jobs`
  List jobs with filters for status, source, target, bot, date range, and tenant.
- `GET /api/jobs/:id`
  Show job detail with attempts.
- `POST /api/jobs/:id/retry`
  Requeue one failed/resolved/ignored job.
- `POST /api/jobs/bulk-retry`
  Requeue selected failed jobs.
- `POST /api/jobs/:id/resolve`
  Mark a failed job as resolved.
- `POST /api/jobs/:id/ignore`
  Mark a failed job as ignored.
- `GET /api/bot-health`
  List detailed health rows.
- `POST /api/bot-health/:botId/reconnect`
  Trigger manual reconnect.
- `GET /api/operational-events`
  List timeline events with filters.
- `GET /api/ops/summary`
  Return dashboard counts for queue depth, retrying, failed, sent today, online bots, offline bots, and stale bots.

## UI Changes

### Dashboard

Add operational summary cards:

- Queue depth
- Retrying jobs
- Failed jobs
- Sent today
- Online bots
- Offline/stale bots

Add compact lists for recent failures and recent operational events.

### Bot Management

Show bot health details:

- Health status
- Last seen
- Consecutive failures
- Cooldown until
- Last error
- Reconnect action

### Failure Inbox

Replace the current simple failed request list with a support workflow:

- Filter by tenant, status, source, bot, target, and error text.
- Show attempt history per job.
- Retry one job.
- Bulk retry selected jobs.
- Mark failed jobs resolved or ignored.

### Operational Timeline

Add a readable event stream:

- Bot connected/disconnected/reconnecting/QR-required.
- Job queued/sent/failed/retried.
- Group blocked/unblocked.
- Webhook key created/deleted.
- Tenant created/deactivated.

## Delivery Flow

1. API receives a send request.
2. Auth and tenant scope are validated through existing middleware.
3. `queueService` creates one `message_jobs` row per target.
4. API returns queued job IDs.
5. `deliveryWorker` locks eligible jobs.
6. `routingService` selects a healthy bot.
7. Worker sends via the existing bot socket.
8. Worker records an attempt.
9. Success marks the job `sent`.
10. Failure schedules retry or marks the job `failed`.
11. UI reads job and event state from PostgreSQL.

## Error Handling

- No healthy bot: job becomes `retrying` until max attempts, then `failed`.
- Send timeout or Baileys error: bot failure count increases, job retries with backoff.
- Invalid group or rejected target: job fails without repeated retry once the error is classified as non-retryable.
- Process restart: unlocked queued/retrying jobs remain durable and are picked up after restart.
- Worker crash while sending: jobs locked too long are unlocked by a stale-lock recovery pass.

## Testing Strategy

Backend tests should mock the WhatsApp socket layer and cover:

- Job enqueue from API payloads.
- Worker success path.
- Worker retry path.
- Max-attempt failure path.
- Manual retry path.
- Bot routing excludes unhealthy/cooldown bots.
- Sticky route is reused when healthy.
- Audit events are written for important transitions.
- Tenant isolation on jobs, attempts, health, and events.

Frontend tests can be lighter in this phase and focus on:

- Failure Inbox renders jobs and attempts.
- Retry and bulk retry trigger the expected API calls.
- Bot health status renders correctly.
- Dashboard summary handles empty and populated states.

## Rollout Plan

1. Add schema migrations to `backend/db/init.sql`.
2. Add backend services and tests around queue, worker, retry, routing, health, and audit.
3. Wire send routes to enqueue jobs.
4. Start the worker and health monitor from `backend/index.js`.
5. Add operations APIs.
6. Update dashboard, bot management, failed requests, and logs/timeline UI.
7. Run backend and frontend verification.

## Compatibility Notes

- Existing page routes remain in place.
- Existing send endpoints remain in place.
- The major behavior change is that send endpoints return queued job IDs instead of final send results.
- Existing `failed_requests` can remain during transition, but new failure workflows should read from `message_jobs` and `message_job_attempts`.
- Raw log files remain useful for low-level debugging, while `operational_events` becomes the primary dashboard timeline.
