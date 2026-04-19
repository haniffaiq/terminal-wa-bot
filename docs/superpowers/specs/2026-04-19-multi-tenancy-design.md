# Multi-Tenancy — Design Spec

## Overview

Add multi-tenant support to ZYRON. Each tenant gets isolated bots, groups, stats, and a personalized bot experience. Tenants are created by a super admin. Each tenant has its own admin bot, operation bots, and customizable command responses.

## Decisions

| Decision | Choice |
|----------|--------|
| Tenant creation | Super admin only |
| Tenant identification | JWT token-based (same URL for all tenants) |
| Authentication | JWT (bcrypt password hashing) |
| Bot personalization | brand_name prefix + custom commands with template variables |
| Super admin UI | Same dashboard, extra menu for tenant management |

## Database Schema

### New Tables

```sql
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    brand_name VARCHAR(50) NOT NULL,
    admin_bot_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'admin',  -- 'super_admin' | 'admin'
    created_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE custom_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    command VARCHAR(50) NOT NULL,
    response_template TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, command)
);

CREATE TABLE bot_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    bot_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'close',
    is_admin_bot BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, bot_id)
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_commands_tenant ON custom_commands(tenant_id);
CREATE INDEX idx_bot_status_tenant ON bot_status(tenant_id);
```

### Modified Tables

```sql
ALTER TABLE message_stats ADD COLUMN tenant_id UUID REFERENCES tenants(id);
ALTER TABLE failed_requests ADD COLUMN tenant_id UUID REFERENCES tenants(id);

CREATE INDEX idx_stats_tenant ON message_stats(tenant_id);
CREATE INDEX idx_failed_tenant ON failed_requests(tenant_id);
```

### Super Admin Seed

On first run, create the super admin user:
- `role = 'super_admin'`
- `tenant_id = NULL`
- `username` and `password` from env vars `SUPER_ADMIN_USER` / `SUPER_ADMIN_PASSWORD` (default: `admin` / `admin123`)

## Authentication

### JWT Flow

1. `POST /api/auth/login` — `{ username, password }`
2. Verify bcrypt hash against `users.password_hash`
3. Check `users.is_active` and (if not super_admin) `tenants.is_active`
4. Generate JWT payload: `{ userId, tenantId, role, brandName }`
5. JWT secret from env var `JWT_SECRET` (default: `zyron-secret-change-me`)
6. Token expiry: 24 hours
7. Frontend stores token in `sessionStorage`

### Middleware Stack

```
request
  → cors
  → express.json()
  → authMiddleware
      - Skip for POST /api/auth/login
      - Verify JWT, reject 401 if invalid/expired
      - Inject req.user = { userId, tenantId, role, brandName }
  → route handlers
      - All data queries MUST filter by req.user.tenantId
      - Super admin (tenantId = null) can access cross-tenant data
```

### IDOR Prevention Rules

- Tenant admin NEVER passes `tenant_id` in request body/params — always from JWT
- Custom command CRUD: verify `command.tenant_id === req.user.tenantId` before modify/delete
- Bot operations: verify bot belongs to tenant via `bot_status` table before restart/disconnect/delete
- Super admin endpoints: check `req.user.role === 'super_admin'` before allowing access

### XSS Prevention

- All user input (brand_name, command templates, messages) sanitized on output
- Frontend uses React (auto-escapes by default)
- Custom command templates: variables replaced server-side, no raw HTML injection possible
- Content-Security-Policy headers on frontend Nginx

## Bot Isolation

### Data Structures

```javascript
// Per-tenant bot storage
operationBots = {
    "tenant-uuid-1": { "bot_01": sock, "bot_02": sock },
    "tenant-uuid-2": { "bot_03": sock }
}

// Per-tenant group cache
groupCache = {
    "tenant-uuid-1": Map({ groupId → { id, name, member_count, bots } }),
    "tenant-uuid-2": Map({ groupId → { id, name, member_count, bots } })
}
```

### Auth Sessions

Session folders scoped by tenant:
```
auth_sessions/{tenantId}/{botId}/
```

### Admin Bot Per Tenant

- Each tenant has exactly 1 admin bot (stored in `tenants.admin_bot_id`)
- Admin bot created when tenant admin adds their first bot with `is_admin_bot: true`
- Admin bot handles WhatsApp commands for that tenant only
- System commands use tenant's `brand_name` instead of hardcoded "ZYRON"

### Bot Status

Migrated from file (`data/bot_status.json`) to database (`bot_status` table). All reads/writes scoped by `tenant_id`.

### Socket.io Scoping

- Client sends JWT token in handshake auth
- Backend verifies token, joins client to room `tenant:{tenantId}`
- `bot:status`, `bot:qr`, `bot:connected` events emitted only to the tenant's room
- Super admin joins room `super_admin` and receives all events

## Custom Commands

### System Commands (reserved, cannot be overridden)

`!addbot`, `!rst`, `!rmbot`, `!block`, `!open`, `!listblock`, `!botstatus`, `!restart`, `!groupid`, `!hi`, `!ho`, `!info`, `!cmd`, `!pmtcmt`

### Custom Command Rules

- Command name must start with `!`
- Cannot conflict with system commands
- Stored in `custom_commands` table, scoped by `tenant_id`

### Template Variables

| Variable | Value |
|----------|-------|
| `{brand}` | Tenant brand_name |
| `{date}` | Current date (DD/MM/YYYY) |
| `{time}` | Current time (HH:MM:SS) |
| `{group_name}` | Group name where command was sent |
| `{group_id}` | Group JID |
| `{bot_count}` | Number of online bots for this tenant |
| `{member_count}` | Number of members in the group |
| `{sender}` | Phone number of command sender |

### Message Processing Flow

```
incoming WhatsApp message
  → determine which tenant owns this admin bot
  → check if system command → run system handler (with tenant brand_name)
  → check custom_commands WHERE tenant_id AND command → replace variables, send response
  → no match → ignore
```

## API Endpoints

### Public

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login` | Login, returns JWT |

### Super Admin Only

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tenants` | List all tenants |
| POST | `/api/tenants` | Create tenant + user |
| PUT | `/api/tenants/:id` | Update tenant |
| DELETE | `/api/tenants/:id` | Deactivate tenant |

### Tenant Admin (scoped by JWT tenant_id)

All existing endpoints remain, scoped by tenant_id:
- `/api/send-message`, `/api/send-media`, `/api/send-media-from-url`
- `/api/addbot`, `/api/restart`, `/api/disconnect`, `/api/deletebot`
- `/api/bot-status`, `/api/groups`, `/api/groups/block`, `/api/groups/unblock`
- `/api/stats/:date`, `/api/logs/:type/:date`
- `/api/failed-requests`, `/api/resend-failed`
- `/api/list-my-groups`

New tenant-scoped endpoints:
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/commands` | List tenant's custom commands |
| POST | `/api/commands` | Create custom command |
| PUT | `/api/commands/:id` | Update custom command |
| DELETE | `/api/commands/:id` | Delete custom command |
| PUT | `/api/tenant/profile` | Update own brand_name |

## Frontend Changes

### Auth Module (`lib/auth.ts`)

- Remove Basic Auth, replace with JWT
- `login(username, password)` → call `/api/auth/login`, store token in `sessionStorage`
- `getAuthHeader()` → return `Bearer <token>`
- `getUser()` → decode JWT payload, return `{ userId, tenantId, role, brandName }`

### Route Protection

- Check token valid + not expired on every navigation
- Expired → redirect to login
- Role-based route guard: super admin pages hidden from tenant admin

### Layout

- Sidebar title: show `brandName` from JWT (dynamic per tenant)
- Super admin sees extra menu item: **Tenant Management**
- Tenant admin sees extra menu item: **Custom Commands**

### New Pages

**Tenant Management** (super admin only):
- Table: tenant name, brand, active bots count, users count, created_at, is_active
- Create form: name, brand_name, username, password
- Edit: update name, brand_name, toggle is_active
- Delete: deactivate (soft delete)

**Custom Commands** (tenant admin):
- Table: command, template preview, created_at
- Create: command name input + template textarea with variable hints
- Edit/Delete per row
- Preview: render template with sample data

### Socket.io

- Send JWT token in handshake `auth.token` instead of username/password
- Backend verifies and assigns to tenant room

## Docker Changes

### Environment Variables

Add to `docker-compose.yml` backend service:
```yaml
- JWT_SECRET=your-secret-here
- SUPER_ADMIN_USER=admin
- SUPER_ADMIN_PASSWORD=admin123
```

### Database Migration

Update `db/init.sql` with all new tables. On startup, backend runs migration check and seeds super admin if not exists.

## Security Checklist

- [x] JWT auth with expiry (24h)
- [x] bcrypt password hashing
- [x] Tenant isolation via middleware (tenant_id from JWT, never from client)
- [x] IDOR prevention: all CRUD operations verify ownership
- [x] XSS prevention: React auto-escape + server-side template variable replacement
- [x] System commands cannot be overridden by custom commands
- [x] Super admin routes guarded by role check
- [x] SQL injection: parameterized queries via pg driver
- [x] Soft delete for tenants (preserve data integrity)
- [x] Bot session isolation by tenant folder
