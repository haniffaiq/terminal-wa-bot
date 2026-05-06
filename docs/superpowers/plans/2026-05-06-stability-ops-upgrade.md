# Stability Ops Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build durable WhatsApp delivery queueing, retry, bot health, smarter routing, audit timeline, and a support-oriented failure inbox.

**Architecture:** Keep the current Express/PostgreSQL/Baileys architecture, add Redis as a Docker-managed queue runtime, and use BullMQ for delivery queueing and delayed retry execution. PostgreSQL remains the durable job/audit source of truth; Redis holds executable queue state and delayed jobs. Update the React dashboard to consume new operations APIs while keeping existing navigation and visual patterns.

**Tech Stack:** Node.js, Express, PostgreSQL, Redis, BullMQ, Baileys, node:test, React, TypeScript, Vite, Tailwind, lucide-react.

---

## Docker Runtime Notes

- The app runs through `docker-compose.yml`.
- Redis must run as a Docker Compose service using `redis:7-alpine`.
- Redis persistence must be enabled with append-only file mode and a named `redisdata` volume.
- Backend must use `REDIS_URL=redis://redis:6379` in Docker.
- Backend code must work inside container path `/app`.
- Durable uploaded media jobs must store paths under mounted `backend/uploads`, because Docker mounts `./backend/uploads:/app/uploads`.
- Database schema changes go into `backend/db/init.sql`; existing Docker volume `pgdata` will not replay init SQL automatically on an already-created database.
- Final Docker verification should use `docker compose build backend frontend` and `docker compose up -d` when Docker is available.
- For an existing deployed database, the same SQL additions from `init.sql` must be applied manually or through a migration before worker routes are used.
- Backend startup must reconcile PostgreSQL `queued`/`retrying` jobs into Redis so Redis container recreation does not orphan jobs.

## Baseline State

- Backend `npm test` currently fails with `Error: no test specified`.
- Frontend `npm run build` passes.
- Frontend `npm run lint` has 14 pre-existing errors and 2 warnings unrelated to this feature.
- Use backend `node --test tests/*.test.js` for new backend unit tests.
- Use frontend `npm run build` as the frontend verification gate unless lint baseline is fixed separately.

## File Structure

- Modify `backend/db/init.sql`: add operations tables and indexes.
- Modify `docker-compose.yml`: add Redis container, Redis volume, backend env, and backend dependency on Redis.
- Modify `backend/package.json` and `backend/package-lock.json`: add useful test script and BullMQ dependency.
- Create `backend/services/retryService.js`: retry classification and backoff policy.
- Create `backend/services/redisQueue.js`: BullMQ Queue/Worker connection factory.
- Create `backend/services/auditService.js`: operational event writer and list helper.
- Create `backend/services/botHealthService.js`: bot health writes, stale detection, cooldown helpers.
- Create `backend/services/routingService.js`: sticky route and healthy bot selection.
- Create `backend/services/queueService.js`: create PostgreSQL job rows, enqueue BullMQ jobs, requeue unresolved jobs, status transitions, attempts, job list APIs.
- Create `backend/services/deliveryWorker.js`: BullMQ worker, retry scheduling, and send state transitions.
- Create `backend/services/messageSender.js`: payload-to-Baileys send adapter.
- Create `backend/services/schemaService.js`: startup-safe operations schema migration for reused Docker `pgdata`.
- Create `backend/routes/operations.js`: jobs, bot health, events, ops summary routes.
- Modify `backend/bots/operationBot.js`: export bot socket access, emit health/audit events, integrate health on status changes.
- Modify `backend/routes/webhook.js`: enqueue webhook sends.
- Modify `backend/utils/scheduler.js`: enqueue scheduled sends.
- Modify `backend/index.js`: mount operations routes, enqueue primary send routes, start worker and health monitor.
- Create `backend/tests/retryService.test.js`: retry policy tests.
- Create `backend/tests/routingService.test.js`: routing selection tests.
- Create `backend/tests/queueService.test.js`: enqueue shape and validation tests.
- Modify `frontend/src/lib/api.ts`: add operations response types only if needed by pages.
- Modify `frontend/src/pages/Dashboard.tsx`: display operations summary and recent ops.
- Modify `frontend/src/pages/BotManagement.tsx`: show detailed bot health.
- Modify `frontend/src/pages/FailedRequests.tsx`: replace failed request list with job-based failure inbox.
- Create `frontend/src/pages/OperationalTimeline.tsx`: readable timeline page.
- Modify `frontend/src/components/Layout.tsx`: add Timeline navigation item.
- Modify `frontend/src/App.tsx`: add `/timeline` route.

## Task 1: Backend Test Harness and Retry Service

**Files:**
- Modify: `backend/package.json`
- Create: `backend/services/retryService.js`
- Create: `backend/tests/retryService.test.js`

- [ ] **Step 1: Write failing retry tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getRetryDelaySeconds,
    getNextJobStateAfterFailure,
    isRetryableError
} = require('../services/retryService');

test('retry delays use 1m, 5m, 15m policy', () => {
    assert.equal(getRetryDelaySeconds(1), 60);
    assert.equal(getRetryDelaySeconds(2), 300);
    assert.equal(getRetryDelaySeconds(3), 900);
    assert.equal(getRetryDelaySeconds(9), 900);
});

test('job retries before max attempts', () => {
    const state = getNextJobStateAfterFailure({
        attemptCount: 1,
        maxAttempts: 3,
        error: new Error('No active bot')
    });
    assert.equal(state.status, 'retrying');
    assert.equal(state.delaySeconds, 60);
    assert.equal(state.final, false);
});

test('job fails when max attempts reached', () => {
    const state = getNextJobStateAfterFailure({
        attemptCount: 3,
        maxAttempts: 3,
        error: new Error('No active bot')
    });
    assert.equal(state.status, 'failed');
    assert.equal(state.delaySeconds, 0);
    assert.equal(state.final, true);
});

test('invalid group style errors are not retryable', () => {
    assert.equal(isRetryableError(new Error('invalid group')), false);
    assert.equal(isRetryableError(new Error('No active bot')), true);
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test tests/retryService.test.js`

Expected: FAIL because `../services/retryService` does not exist.

- [ ] **Step 3: Implement retry service**

```js
const RETRY_DELAYS_SECONDS = [60, 300, 900];
const NON_RETRYABLE_PATTERNS = [
    'invalid group',
    'not a group',
    'bad target',
    'recipient not found'
];

function getRetryDelaySeconds(attemptCount) {
    const index = Math.max(0, attemptCount - 1);
    return RETRY_DELAYS_SECONDS[Math.min(index, RETRY_DELAYS_SECONDS.length - 1)];
}

function normalizeErrorMessage(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return error.message || String(error);
}

function isRetryableError(error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    if (!message) return true;
    return !NON_RETRYABLE_PATTERNS.some(pattern => message.includes(pattern));
}

function getNextJobStateAfterFailure({ attemptCount, maxAttempts, error }) {
    const retryable = isRetryableError(error);
    if (!retryable || attemptCount >= maxAttempts) {
        return { status: 'failed', delaySeconds: 0, final: true };
    }
    return {
        status: 'retrying',
        delaySeconds: getRetryDelaySeconds(attemptCount),
        final: false
    };
}

module.exports = {
    getRetryDelaySeconds,
    getNextJobStateAfterFailure,
    isRetryableError,
    normalizeErrorMessage
};
```

- [ ] **Step 4: Add backend test script**

Set `backend/package.json` script:

```json
"test": "node --test tests/*.test.js"
```

- [ ] **Step 5: Verify**

Run: `npm test`

Expected: PASS for retry tests.

## Task 2: Operations Schema

**Files:**
- Modify: `backend/db/init.sql`

- [ ] **Step 1: Add schema**

Add tables: `message_jobs`, `message_job_attempts`, `bot_health`, `operational_events`, `bot_group_routes`.

- [ ] **Step 2: Verify SQL structure**

Run: `rg -n "message_jobs|message_job_attempts|bot_health|operational_events|bot_group_routes" backend/db/init.sql`

Expected: each table and indexes appear.

## Task 2A: Redis Queue Runtime

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Create: `backend/services/redisQueue.js`

- [ ] **Step 1: Add Redis Docker service**

Add a `redis` service:

```yaml
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    restart: unless-stopped
```

Add backend env:

```yaml
      - REDIS_URL=redis://redis:6379
```

Add backend `depends_on` entry for `redis`.

Add top-level volume:

```yaml
  redisdata:
```

- [ ] **Step 2: Install BullMQ**

Run from `backend/`:

```bash
npm install bullmq
```

Expected: `backend/package.json` and `backend/package-lock.json` update.

- [ ] **Step 3: Create Redis queue helper**

Create `backend/services/redisQueue.js` with:

```js
const { Queue, Worker, QueueEvents } = require('bullmq');

const QUEUE_NAME = 'message-delivery';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function buildConnectionOptions(redisUrl = REDIS_URL) {
    const url = new URL(redisUrl);
    return {
        host: url.hostname,
        port: Number(url.port || 6379),
        password: url.password || undefined
    };
}

function createDeliveryQueue(options = {}) {
    return new Queue(options.queueName || QUEUE_NAME, {
        connection: options.connection || buildConnectionOptions(options.redisUrl)
    });
}

function createDeliveryWorker(processor, options = {}) {
    return new Worker(options.queueName || QUEUE_NAME, processor, {
        connection: options.connection || buildConnectionOptions(options.redisUrl),
        concurrency: options.concurrency || 1
    });
}

function createDeliveryQueueEvents(options = {}) {
    return new QueueEvents(options.queueName || QUEUE_NAME, {
        connection: options.connection || buildConnectionOptions(options.redisUrl)
    });
}

module.exports = {
    QUEUE_NAME,
    buildConnectionOptions,
    createDeliveryQueue,
    createDeliveryWorker,
    createDeliveryQueueEvents
};
```

- [ ] **Step 4: Verify**

Run:

```bash
node --check services/redisQueue.js
npm test
```

Expected: syntax passes and backend tests pass.

## Task 3: Queue, Audit, Health, Routing Services

**Files:**
- Create: `backend/services/auditService.js`
- Create: `backend/services/botHealthService.js`
- Create: `backend/services/routingService.js`
- Create: `backend/services/queueService.js`
- Create: `backend/tests/routingService.test.js`
- Create: `backend/tests/queueService.test.js`

- [ ] **Step 1: Write routing tests**

Test healthy sticky route reuse, cooldown exclusion, and lower load preference with injected dependencies.

- [ ] **Step 2: Write queue tests**

Test target normalization, max 10 target validation, text job payload shape with injected query function, and that enqueue adds the created PostgreSQL job ID to the injected Redis/BullMQ queue adapter.

- [ ] **Step 3: Implement services**

Use CommonJS modules. Keep database writes behind injected `queryFn` options and Redis queue writes behind an injected `deliveryQueue` option for unit testing.

- [ ] **Step 4: Verify**

Run: `npm test`

Expected: PASS for retry, routing, and queue tests.

## Task 4: Delivery Worker and Message Sender

**Files:**
- Create: `backend/services/messageSender.js`
- Create: `backend/services/deliveryWorker.js`

- [ ] **Step 1: Implement message sender**

Support payload types:

- `text`: `sock.sendMessage(targetId, { text })`
- `media_upload`: read file path and send image/video/audio/document based on mimetype.
- `media_url`: download URL and send image for `image/*`, document otherwise.

- [ ] **Step 2: Implement worker**

Use BullMQ `Worker` from `redisQueue.createDeliveryWorker`, `queueService.getJob`, `routingService.selectBotForJob`, `messageSender.sendJob`, `queueService.recordAttempt`, and retry policy. On retryable failure, update PostgreSQL status to `retrying` and enqueue a delayed BullMQ job for the same PostgreSQL job ID.

- [ ] **Step 3: Verify syntax**

Run: `node --check services/deliveryWorker.js` and `node --check services/messageSender.js`

Expected: both pass.

## Task 5: Wire Backend Routes

**Files:**
- Create: `backend/routes/operations.js`
- Create: `backend/services/schemaService.js`
- Modify: `backend/routes/webhook.js`
- Modify: `backend/utils/scheduler.js`
- Modify: `backend/index.js`
- Modify: `backend/bots/operationBot.js`

- [ ] **Step 1: Add operations routes**

Implement:

- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/retry`
- `POST /api/jobs/bulk-retry`
- `POST /api/jobs/:id/resolve`
- `POST /api/jobs/:id/ignore`
- `GET /api/bot-health`
- `POST /api/bot-health/:botId/reconnect`
- `GET /api/operational-events`
- `GET /api/ops/summary`

- [ ] **Step 2: Change send routes to enqueue**

Make `/api/send-message`, `/api/send-media`, `/api/send-media-from-url`, webhook send, and scheduler send create queue jobs.

- [ ] **Step 3: Start worker and health monitor**

Call `ensureOperationsSchema()`, `requeuePendingJobs()`, `startDeliveryWorker()`, and `startBotHealthMonitor()` from `backend/index.js` in that order.

- [ ] **Step 4: Add startup schema migration**

Backend startup must apply the operations schema to existing Docker databases, because reused `pgdata` volumes will not replay `backend/db/init.sql`. Add a startup-safe migration before worker routes depend on the operations tables.

- [ ] **Step 5: Verify backend syntax**

Run: `node --check index.js`, `node --check routes/operations.js`, and `npm test`.

Expected: syntax passes and tests pass.

## Task 6: Frontend Operations UI

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/pages/BotManagement.tsx`
- Modify: `frontend/src/pages/FailedRequests.tsx`
- Create: `frontend/src/pages/OperationalTimeline.tsx`
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Dashboard**

Add cards for queue depth, retrying, failed, sent today, online bots, offline bots. Add recent failures and recent operational events.

- [ ] **Step 2: Bot Management**

Add detailed health table beneath existing bot controls.

- [ ] **Step 3: Failure Inbox**

Use `/jobs?status=failed,retrying` and show attempt history, retry, bulk retry, resolve, ignore.

- [ ] **Step 4: Timeline**

Add `/timeline` page backed by `/operational-events`.

- [ ] **Step 5: Verify frontend build**

Run: `npm run build`

Expected: PASS. Lint remains baseline-failing unless separately fixed.

## Task 7: Final Verification

**Files:**
- All changed files.

- [ ] **Step 1: Backend tests**

Run: `cd backend && npm test`

Expected: PASS.

- [ ] **Step 2: Backend syntax**

Run selected `node --check` commands for changed backend files.

Expected: PASS.

- [ ] **Step 3: Frontend build**

Run: `cd frontend && npm run build`

Expected: PASS.

- [ ] **Step 4: Docker build**

Run: `docker compose build backend frontend`

Expected: backend and frontend images build without errors. Backend image must include BullMQ dependency.

- [ ] **Step 5: Docker start**

Run: `docker compose up -d`

Expected: `db`, `redis`, `backend`, and `frontend` services start. Backend startup must apply the operations schema to an existing Docker database; do not rely only on fresh `backend/db/init.sql`, because reused `pgdata` volumes will not replay it. Redis must persist data through the `redisdata` volume.

- [ ] **Step 6: Git review**

Run: `git status --short`, `git diff --stat`, and inspect major diffs.

Expected: only intended implementation files changed.
