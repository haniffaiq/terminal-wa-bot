# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ZYRON is a multi-tenant WhatsApp bot delivery gateway. Each tenant gets isolated bots, groups, statistics, and customizable bot responses. Built with Node.js/Express, Baileys (WhatsApp), PostgreSQL, and a React dashboard.

## Project Structure

```
terminal-wa-bot/
├── backend/          # Node.js Express + socket.io server
├── frontend/         # React + Vite + TypeScript dashboard
├── docker-compose.yml
└── docs/
```

## Running the Project

### Development

```bash
# Backend (requires PostgreSQL running)
cd backend && npm install && node index.js    # port 8008

# Frontend (separate terminal)
cd frontend && npm install && npm run dev     # port 5173 (proxies /api to backend)
```

### Docker Compose

```bash
docker compose up --build    # backend:8008, frontend:3000, postgres:5432
./redeploy.sh                # full rebuild shortcut
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `wabot` | Database name |
| `DB_USER` | `wabot` | Database user |
| `DB_PASSWORD` | `wabot123` | Database password |
| `JWT_SECRET` | `zyron-secret-change-me` | JWT signing secret |
| `SUPER_ADMIN_USER` | `admin` | Initial super admin username |
| `SUPER_ADMIN_PASSWORD` | `admin123` | Initial super admin password |

## Multi-Tenancy Architecture

### Roles
- **Super Admin** — `role='super_admin'`, `tenant_id=NULL`. Creates/manages tenants. Sees all data.
- **Tenant Admin** — `role='admin'`, scoped to their `tenant_id`. Manages own bots, groups, commands.

### Auth Flow
1. `POST /api/auth/login` → returns JWT token
2. JWT payload: `{ userId, tenantId, role, brandName }`
3. Token stored in `sessionStorage`, sent as `Authorization: Bearer <token>`
4. Middleware extracts tenant context from JWT — all queries scoped by `tenantId`

### Data Isolation
- All DB queries filter by `tenant_id` (from JWT, never from client input)
- Bot sockets: `operationBots[tenantId][botId]`
- Group cache: `groupCache[tenantId] = Map(...)`
- Auth sessions: `auth_sessions/{tenantId}/{botId}/`
- Socket.io rooms: `tenant:{tenantId}` per tenant, `super_admin` for admin

### Custom Commands
- Tenants create custom WhatsApp commands (e.g. `!stock`) via dashboard
- Response templates support variables: `{brand}`, `{date}`, `{time}`, `{group_name}`, `{group_id}`, `{bot_count}`, `{member_count}`, `{sender}`
- System commands (e.g. `!addbot`, `!rst`) cannot be overridden

## Backend Architecture

**Entry point:** `backend/index.js` — Express + socket.io, JWT auth middleware, API routes prefixed `/api`.

**Bot types (per tenant):**
- **Admin bot** (`bots/adminBot.js`) — one per tenant, handles WhatsApp commands with tenant's `brand_name`
- **Operation bots** (`bots/operationBot.js`) — multiple per tenant, round-robin message delivery

**Key modules:**
- `utils/auth.js` — JWT sign/verify, bcrypt hash/compare
- `utils/midleware.js` — JWT auth middleware, `requireSuperAdmin` guard
- `utils/db.js` — PostgreSQL connection pool
- `utils/seed.js` — seeds super admin user on first run
- `utils/statmanager.js` — message stats (PostgreSQL)
- `utils/createSock.js` — Baileys socket factory
- `routes/auth.js` — login endpoint
- `routes/tenants.js` — super admin tenant CRUD
- `routes/commands.js` — custom commands CRUD

**Database tables:** `tenants`, `users`, `custom_commands`, `bot_status`, `message_stats`, `failed_requests`

## Frontend Architecture

**Tech stack:** React, Vite, TypeScript, Tailwind CSS, shadcn/ui (base-ui), recharts, socket.io-client

**Auth:** JWT-based. `src/lib/auth.ts` stores token in sessionStorage, decodes payload for user info.

**Pages:** Dashboard, BotManagement, SendMessage, Groups, FailedRequests, Statistics, Logs, CustomCommands (tenant admin), TenantManagement (super admin)

**Note:** shadcn/ui uses `@base-ui/react` (not radix-ui). Check `src/components/ui/` for actual component APIs.

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

### Tenant Admin (scoped by JWT)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/send-message` | Broadcast text to groups |
| POST | `/api/send-media` | Send uploaded file |
| POST | `/api/send-media-from-url` | Send URL media |
| POST | `/api/addbot` | Create new bot |
| POST | `/api/restart` | Restart bot |
| POST | `/api/disconnect` | Disconnect bot |
| POST | `/api/deletebot` | Delete bot |
| GET | `/api/bot-status` | Bot statuses |
| GET | `/api/groups` | List groups |
| GET | `/api/stats/:date` | Daily stats |
| GET | `/api/logs/:type/:date` | Log viewer |
| GET | `/api/failed-requests` | Failed requests |
| POST | `/api/resend-failed` | Retry failed |
| GET | `/api/commands` | List custom commands |
| POST | `/api/commands` | Create command |
| PUT | `/api/commands/:id` | Update command |
| DELETE | `/api/commands/:id` | Delete command |
| PUT | `/api/tenant/profile` | Update brand name |
