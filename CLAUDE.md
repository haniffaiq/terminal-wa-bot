# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Terminal WA Bot is a Node.js WhatsApp bot delivery gateway for internal operational teams. It broadcasts messages to WhatsApp groups through multiple bot accounts using the Baileys library, with an Express HTTP API, socket.io realtime events, and a React frontend dashboard.

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
# Backend
cd backend && npm install && node index.js    # port 8008

# Frontend (separate terminal)
cd frontend && npm install && npm run dev     # port 5173 (proxies /api to backend)
```

### Docker Compose

```bash
docker compose up --build    # backend:8008, frontend:3000
```

### Production (PM2, backend only)

```bash
cd backend
pm2 start index.js --name terminal-wa-bot
```

No test suite exists.

## Backend Architecture

**Entry point:** `backend/index.js` — Express app + socket.io server, API routes (all prefixed `/api`), logging, transaction ID generation.

**Two bot types:**
- **Admin bot** (`bots/adminBot.js`) — single master bot handling WhatsApp commands (`!addbot`, `!rst`, `!block`, etc.)
- **Operation bots** (`bots/operationBot.js`) — multiple worker bots for message delivery; round-robin selection per group

**Supporting modules:**
- `utils/createSock.js` — Baileys socket factory, auth state, QR code generation, emits `bot:status` via socket.io
- `utils/midleware.js` — Basic Auth middleware
- `utils/statmanager.js` — hourly message delivery stats, persisted to `stats/` as JSON
- `bots/hertbeat.js` — monitors bot connection status every 5 seconds
- `bots/proxyConfig.js` — proxy configuration (gitignored)

**Data flow:** API request → Basic Auth → resolve target groups → `getNextBotForGroup()` round-robin → Baileys sends message → tracked with transaction ID → failures saved to `failed_requests.json`.

**Socket.io events:**
- `bot:status` (server→client) — bot connect/disconnect updates
- `bot:qr` (server→client) — QR code for new bot login
- `bot:add` (client→server) — request to create new bot

## Frontend Architecture

**Tech stack:** React, Vite, TypeScript, Tailwind CSS, shadcn/ui (base-ui), recharts, socket.io-client

**Key files:**
- `src/lib/auth.ts` — in-memory Basic Auth credential store
- `src/lib/api.ts` — `fetchApi`/`postApi`/`uploadFile` wrappers with auto-inject auth header
- `src/lib/socket.ts` — socket.io client singleton
- `src/hooks/useSocket.ts` — React hook for realtime bot status and QR events
- `src/components/Layout.tsx` — sidebar navigation with 7 pages
- `src/components/Login.tsx` — login form, validates against `/api/bot-status`

**Pages:** Dashboard, BotManagement, SendMessage, Groups, FailedRequests, Statistics, Logs

**Note:** shadcn/ui components use `@base-ui/react` (not radix-ui). Check component files in `src/components/ui/` for actual API before using.

## API Endpoints

All prefixed with `/api`, require Basic Auth (`wa-ops` / `wapass@2021`).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/send-message` | Broadcast text to groups |
| POST | `/api/send-media` | Send uploaded file to groups |
| POST | `/api/send-media-from-url` | Fetch URL media and send |
| POST | `/api/addbot` | Create new operation bot |
| POST | `/api/restart` | Restart a specific bot |
| POST | `/api/disconnect` | Force disconnect bot |
| GET | `/api/bot-status` | Get all bot connection statuses |
| GET | `/api/list-my-groups` | List groups from active bots |
| POST | `/api/resend-failed` | Retry all failed requests |
| GET | `/api/stats/:date` | Stats JSON for a date (YYYY-MM-DD) |
| GET | `/api/logs/:type/:date` | Paginated log content |
| GET | `/api/groups` | List all groups with blocked status |
| POST | `/api/groups/block` | Block a group |
| POST | `/api/groups/unblock` | Unblock a group |
| GET | `/api/failed-requests` | List failed requests |

## Key Patterns

- **Transaction IDs:** Format `{CODE}-{YYYYMMDD}-{HHMMSS}-{EPOCH}`
- **File-based state:** JSON files in `backend/` (`data/bot_status.json`, `blocked.json`, `failed_requests.json`)
- **Per-bot auth sessions:** `backend/auth_sessions/{botId}/`
- **Daily log files:** `backend/logs/` — separate files for success, error, warn, req-res
- **Docker volumes:** `auth_sessions`, `data`, `logs`, `stats`, `uploads` are mounted from host
