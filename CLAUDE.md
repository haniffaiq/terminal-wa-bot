# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Terminal WA Bot is a Node.js WhatsApp bot delivery gateway for internal operational teams. It broadcasts messages to WhatsApp groups through multiple bot accounts using the Baileys library, with an Express HTTP API and WhatsApp-command control interface.

## Running the Project

```bash
npm install
node index.js          # starts Express server on port 8008
```

Production uses PM2:
```bash
pm2 start index.js --name terminal-wa-bot
pm2 logs terminal-wa-bot
pm2 restart terminal-wa-bot
```

No test suite exists (test script is a stub).

## Architecture

**Entry point:** `index.js` — Express app with API routes, logging setup, and transaction ID generation.

**Two bot types:**
- **Admin bot** (`bots/adminBot.js`) — single master bot handling WhatsApp commands (`!addbot`, `!rst`, `!block`, etc.) and bot lifecycle management
- **Operation bots** (`bots/operationBot.js`) — multiple worker bots that perform actual message delivery; selected via round-robin per group

**Supporting modules:**
- `utils/createSock.js` — Baileys socket factory with auth state management and QR code generation
- `utils/midleware.js` — Basic Auth middleware for API endpoints
- `utils/statmanager.js` — hourly message delivery statistics, persisted to `stats/` as JSON
- `bots/hertbeat.js` — monitors bot connection status every 5 seconds
- `bots/proxyConfig.js` — proxy configuration (gitignored)

**Data flow:** API request → Basic Auth → resolve target groups → `getNextBotForGroup()` round-robin selection → Baileys socket sends message → response tracked with transaction ID → failures saved to `failed_requests.json` for retry.

## Key Patterns

- **Transaction IDs:** Format `{CODE}-{YYYYMMDD}-{HHMMSS}-{EPOCH}` for audit trail
- **File-based state:** No database; all state in JSON files (`data/bot_status.json`, `blocked.json`, `failed_requests.json`)
- **Per-bot auth sessions:** Stored in `auth_sessions/{botId}/`
- **Daily log files:** In `logs/` — separate files for success, error, warn, and req-res
- **Media sources:** Direct upload (multipart via multer), base64 in JSON body, or URL download

## API Endpoints

All endpoints require Basic Auth (`wa-ops` / `wapass@2021`).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/send-message` | Broadcast text to groups |
| POST | `/send-media` | Send uploaded file to groups |
| POST | `/send-media-from-url` | Fetch URL media and send to groups |
| POST | `/addbot` | Create new operation bot |
| POST | `/restart` | Restart a specific bot |
| POST | `/disconnect` | Force disconnect bot |
| GET | `/bot-status` | Get all bot connection statuses |
| GET | `/list-my-groups` | List groups from active bots |
| POST | `/resend-failed` | Retry all failed requests |

## Required Directories

These must exist and be writable: `auth_sessions/`, `logs/`, `stats/`, `uploads/`, `data/`.
