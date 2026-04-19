# Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tenant support so each tenant gets isolated bots, groups, stats, custom commands, and personalized bot responses — with JWT auth and IDOR-safe middleware.

**Architecture:** JWT-based auth replaces Basic Auth. Every request carries tenant context from the token. Backend data structures (`operationBots`, `groupCache`) become tenant-keyed maps. Admin bots and WhatsApp command responses use each tenant's `brand_name`. New DB tables for tenants, users, custom_commands, bot_status. Frontend gets tenant-scoped views, super admin gets tenant management.

**Tech Stack:** jsonwebtoken, bcryptjs, PostgreSQL, React, TypeScript

---

## File Structure

### Backend — New Files
- `backend/utils/auth.js` — JWT sign/verify, password hashing, auth middleware
- `backend/routes/auth.js` — login endpoint
- `backend/routes/tenants.js` — super admin CRUD
- `backend/routes/commands.js` — custom commands CRUD
- `backend/utils/seed.js` — super admin seeder on startup

### Backend — Modified Files
- `backend/db/init.sql` — add tenants, users, custom_commands, bot_status tables; alter existing tables
- `backend/package.json` — add jsonwebtoken, bcryptjs
- `backend/index.js` — replace Basic Auth with JWT middleware, mount new routers, scope all queries by tenantId
- `backend/utils/midleware.js` — rewrite: JWT verify + tenant injection
- `backend/utils/statmanager.js` — add tenantId param to increment/getStatsByDate
- `backend/utils/createSock.js` — updateBotStatus writes to DB with tenantId
- `backend/bots/operationBot.js` — tenant-keyed operationBots/groupCache/groupBots, all functions take tenantId
- `backend/bots/adminBot.js` — load tenant brand_name, handle custom commands, scope by tenant
- `backend/bots/hertbeat.js` — read from DB instead of file
- `docker-compose.yml` — add JWT_SECRET, SUPER_ADMIN env vars

### Frontend — New Files
- `frontend/src/pages/TenantManagement.tsx` — super admin page
- `frontend/src/pages/CustomCommands.tsx` — tenant command CRUD

### Frontend — Modified Files
- `frontend/src/lib/auth.ts` — JWT-based auth (store token, decode payload)
- `frontend/src/lib/api.ts` — Bearer token instead of Basic Auth
- `frontend/src/lib/socket.ts` — send JWT token in handshake
- `frontend/src/components/Login.tsx` — POST /api/auth/login
- `frontend/src/components/Layout.tsx` — dynamic brand_name, role-based nav items
- `frontend/src/components/ProtectedRoute.tsx` — check JWT token
- `frontend/src/App.tsx` — add new routes
- `frontend/src/hooks/useSocket.ts` — import from updated auth

---

### Task 1: Database Schema — New Tables & Migrations

**Files:**
- Modify: `backend/db/init.sql`

- [ ] **Step 1: Rewrite init.sql with all tables**

Replace `backend/db/init.sql` with:

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add backend/db/init.sql
git commit -m "feat: add multi-tenant database schema"
```

---

### Task 2: Backend Auth — JWT, bcrypt, middleware

**Files:**
- Create: `backend/utils/auth.js`
- Create: `backend/routes/auth.js`
- Create: `backend/utils/seed.js`
- Modify: `backend/utils/midleware.js`
- Modify: `backend/package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd backend && npm install jsonwebtoken bcryptjs
```

- [ ] **Step 2: Create backend/utils/auth.js**

```javascript
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'zyron-secret-change-me';
const JWT_EXPIRY = '24h';

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}

module.exports = { signToken, verifyToken, hashPassword, comparePassword };
```

- [ ] **Step 3: Create backend/routes/auth.js**

```javascript
const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');
const { signToken, comparePassword } = require('../utils/auth');

router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    try {
        const result = await query(
            `SELECT u.id, u.username, u.password_hash, u.role, u.tenant_id, u.is_active,
                    t.brand_name, t.is_active as tenant_active
             FROM users u
             LEFT JOIN tenants t ON u.tenant_id = t.id
             WHERE u.username = $1`,
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.status(401).json({ success: false, error: 'Account is deactivated' });
        }

        if (user.role !== 'super_admin' && !user.tenant_active) {
            return res.status(401).json({ success: false, error: 'Tenant is deactivated' });
        }

        const valid = await comparePassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const token = signToken({
            userId: user.id,
            tenantId: user.tenant_id,
            role: user.role,
            brandName: user.brand_name || 'ZYRON',
        });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                tenantId: user.tenant_id,
                brandName: user.brand_name || 'ZYRON',
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

module.exports = router;
```

- [ ] **Step 4: Rewrite backend/utils/midleware.js**

Replace the entire file:

```javascript
const { verifyToken } = require('./auth');

function authMiddleware(req, res, next) {
    // Skip auth for login endpoint
    if (req.path === '/api/auth/login') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verifyToken(token);
        req.user = {
            userId: decoded.userId,
            tenantId: decoded.tenantId,
            role: decoded.role,
            brandName: decoded.brandName,
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireSuperAdmin(req, res, next) {
    if (req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
}

module.exports = { authMiddleware, requireSuperAdmin };
```

- [ ] **Step 5: Create backend/utils/seed.js**

```javascript
const { query } = require('./db');
const { hashPassword } = require('./auth');

async function seedSuperAdmin() {
    const username = process.env.SUPER_ADMIN_USER || 'admin';
    const password = process.env.SUPER_ADMIN_PASSWORD || 'admin123';

    try {
        const existing = await query('SELECT id FROM users WHERE role = $1', ['super_admin']);
        if (existing.rows.length > 0) return;

        const hash = await hashPassword(password);
        await query(
            `INSERT INTO users (username, password_hash, role, tenant_id)
             VALUES ($1, $2, 'super_admin', NULL)`,
            [username, hash]
        );
        console.log(`Super admin seeded: ${username}`);
    } catch (err) {
        console.error('Failed to seed super admin:', err.message);
    }
}

module.exports = { seedSuperAdmin };
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add JWT auth, bcrypt, auth middleware, super admin seeder"
```

---

### Task 3: Backend — Tenant CRUD Routes (super admin)

**Files:**
- Create: `backend/routes/tenants.js`

- [ ] **Step 1: Create backend/routes/tenants.js**

```javascript
const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');
const { hashPassword } = require('../utils/auth');
const { requireSuperAdmin } = require('../utils/midleware');

router.use(requireSuperAdmin);

// GET /api/tenants
router.get('/', async (req, res) => {
    try {
        const result = await query(`
            SELECT t.*,
                (SELECT COUNT(*) FROM users WHERE tenant_id = t.id) as user_count,
                (SELECT COUNT(*) FROM bot_status WHERE tenant_id = t.id) as bot_count
            FROM tenants t ORDER BY t.created_at DESC
        `);
        res.json({ success: true, tenants: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/tenants — create tenant + user
router.post('/', async (req, res) => {
    const { name, brand_name, username, password } = req.body;

    if (!name || !brand_name || !username || !password) {
        return res.status(400).json({ success: false, error: 'name, brand_name, username, and password are required' });
    }

    try {
        // Check username uniqueness
        const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }

        // Create tenant
        const tenantResult = await query(
            `INSERT INTO tenants (name, brand_name) VALUES ($1, $2) RETURNING *`,
            [name, brand_name]
        );
        const tenant = tenantResult.rows[0];

        // Create user
        const hash = await hashPassword(password);
        await query(
            `INSERT INTO users (tenant_id, username, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
            [tenant.id, username, hash]
        );

        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/tenants/:id
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, brand_name, is_active } = req.body;

    try {
        const result = await query(
            `UPDATE tenants SET
                name = COALESCE($1, name),
                brand_name = COALESCE($2, brand_name),
                is_active = COALESCE($3, is_active)
             WHERE id = $4 RETURNING *`,
            [name, brand_name, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tenant not found' });
        }

        res.json({ success: true, tenant: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/tenants/:id — soft delete
router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await query('UPDATE tenants SET is_active = FALSE WHERE id = $1', [id]);
        res.json({ success: true, message: 'Tenant deactivated' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add backend/routes/tenants.js
git commit -m "feat: add tenant CRUD routes for super admin"
```

---

### Task 4: Backend — Custom Commands Routes

**Files:**
- Create: `backend/routes/commands.js`

- [ ] **Step 1: Create backend/routes/commands.js**

```javascript
const express = require('express');
const router = express.Router();
const { query } = require('../utils/db');

const SYSTEM_COMMANDS = ['!addbot', '!rst', '!rmbot', '!block', '!open', '!listblock', '!botstatus', '!restart', '!groupid', '!hi', '!ho', '!info', '!cmd', '!pmtcmt'];

// GET /api/commands
router.get('/', async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM custom_commands WHERE tenant_id = $1 ORDER BY created_at',
            [req.user.tenantId]
        );
        res.json({ success: true, commands: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/commands
router.post('/', async (req, res) => {
    const { command, response_template } = req.body;

    if (!command || !response_template) {
        return res.status(400).json({ success: false, error: 'command and response_template are required' });
    }

    if (!command.startsWith('!')) {
        return res.status(400).json({ success: false, error: 'Command must start with !' });
    }

    if (SYSTEM_COMMANDS.includes(command)) {
        return res.status(400).json({ success: false, error: `"${command}" is a reserved system command` });
    }

    try {
        const result = await query(
            `INSERT INTO custom_commands (tenant_id, command, response_template) VALUES ($1, $2, $3) RETURNING *`,
            [req.user.tenantId, command, response_template]
        );
        res.json({ success: true, command: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ success: false, error: 'Command already exists for this tenant' });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/commands/:id
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { command, response_template } = req.body;

    try {
        const existing = await query('SELECT * FROM custom_commands WHERE id = $1', [id]);
        if (existing.rows.length === 0 || existing.rows[0].tenant_id !== req.user.tenantId) {
            return res.status(404).json({ success: false, error: 'Command not found' });
        }

        if (command && SYSTEM_COMMANDS.includes(command)) {
            return res.status(400).json({ success: false, error: `"${command}" is a reserved system command` });
        }

        const result = await query(
            `UPDATE custom_commands SET
                command = COALESCE($1, command),
                response_template = COALESCE($2, response_template)
             WHERE id = $3 AND tenant_id = $4 RETURNING *`,
            [command, response_template, id, req.user.tenantId]
        );
        res.json({ success: true, command: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/commands/:id
router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await query(
            'DELETE FROM custom_commands WHERE id = $1 AND tenant_id = $2 RETURNING id',
            [id, req.user.tenantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Command not found' });
        }

        res.json({ success: true, message: 'Command deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add backend/routes/commands.js
git commit -m "feat: add custom commands CRUD routes"
```

---

### Task 5: Backend — Rewire index.js for JWT & tenant scoping

**Files:**
- Modify: `backend/index.js`

- [ ] **Step 1: Update imports and middleware setup**

At the top of `backend/index.js`, replace:
```javascript
const midleware = require('./utils/midleware');
```
with:
```javascript
const { authMiddleware, requireSuperAdmin } = require('./utils/midleware');
const authRoutes = require('./routes/auth');
const tenantRoutes = require('./routes/tenants');
const commandRoutes = require('./routes/commands');
const { seedSuperAdmin } = require('./utils/seed');
```

Replace:
```javascript
app.use(midleware);
```
with:
```javascript
app.use(authMiddleware);
app.use('/api/auth', authRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/commands', commandRoutes);
```

- [ ] **Step 2: Call seedSuperAdmin on startup**

After `startAdminBot();` and `checkHeartbeatFromFile();`, add:
```javascript
seedSuperAdmin();
```

- [ ] **Step 3: Scope all existing endpoints by tenant_id**

For every endpoint that reads/writes data, use `req.user.tenantId`. Key changes:

**POST /api/send-message**: pass `req.user.tenantId` to `getNextBotForGroup` and `saveFailedRequest`

**GET /api/bot-status**: query `bot_status WHERE tenant_id = $1` instead of reading file

**POST /api/addbot**: insert into `bot_status` with tenant_id, pass tenantId to `startOperationBotAPI`

**POST /api/restart**: verify bot belongs to tenant before restart

**POST /api/disconnect**: verify bot belongs to tenant before disconnect

**POST /api/deletebot**: verify bot belongs to tenant before delete

**GET /api/stats/:date**: pass `req.user.tenantId` to `getStatsByDate`

**GET /api/groups**: pass `req.user.tenantId` to `getAllGroups`

**POST /api/groups/block, /api/groups/unblock**: scope blocked list per tenant (move to DB or tenant-keyed file)

**GET /api/failed-requests**: add `AND tenant_id = $1` to query

**POST /api/resend-failed**: add `AND tenant_id = $1` to query

**GET /api/logs/:type/:date**: logs stay file-based but file names include tenantId: `logs/{tenantId}/success-wa-history-{date}.log`

**PUT /api/tenant/profile**: new endpoint for tenant admin to update own brand_name:
```javascript
app.put('/api/tenant/profile', async (req, res) => {
    const { brand_name } = req.body;
    if (!brand_name) return res.status(400).json({ error: 'brand_name required' });

    try {
        await db.query('UPDATE tenants SET brand_name = $1 WHERE id = $2', [brand_name, req.user.tenantId]);
        res.json({ success: true, message: 'Brand updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
```

- [ ] **Step 4: Update saveFailedRequest to include tenant_id**

```javascript
async function saveFailedRequest(data, transactionId, tenantId) {
    try {
        await db.query(
            `INSERT INTO failed_requests (tenant_id, transaction_id, target_numbers, message, error)
             VALUES ($1, $2, $3, $4, $5)`,
            [tenantId, transactionId, JSON.stringify(data.number || []), data.message || '', data.error || '']
        );
    } catch (err) {
        console.error('Failed to save failed request:', err.message);
    }
}
```

- [ ] **Step 5: Update Socket.io auth to use JWT**

Replace the socket.io auth middleware:
```javascript
const { verifyToken } = require('./utils/auth');

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));

    try {
        const decoded = verifyToken(token);
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    const { tenantId, role } = socket.user;
    // Join tenant-specific room
    if (tenantId) socket.join(`tenant:${tenantId}`);
    if (role === 'super_admin') socket.join('super_admin');

    logger('info', `DASHBOARD connected client=${socket.id} tenant=${tenantId || 'super_admin'}`);

    socket.on('bot:add', async ({ botId }) => {
        if (!botId || !tenantId) return;
        logger('info', `DASHBOARD request=addbot bot=${botId} tenant=${tenantId}`);
        const qrBase64 = await startOperationBotAPI(botId, tenantId);
        if (qrBase64) {
            socket.emit('bot:qr', { botId, qr: qrBase64 });
        }
    });

    socket.on('disconnect', () => {
        logger('info', `DASHBOARD disconnected client=${socket.id}`);
    });
});
```

- [ ] **Step 6: Update bot:status emit to go to tenant room**

In `backend/utils/createSock.js`, change the emit to use the io room:
```javascript
if (status === 'open' || status === 'close') {
    try {
        const { io } = require('../index');
        if (io && tenantId) {
            io.to(`tenant:${tenantId}`).emit('bot:status', { botId, status, timestamp: new Date().toISOString() });
            io.to('super_admin').emit('bot:status', { botId, status, tenantId, timestamp: new Date().toISOString() });
        }
    } catch (e) {}
}
```

Note: `updateBotStatus` signature changes to `updateBotStatus(botId, status, tenantId)`.

- [ ] **Step 7: Remove express-basic-auth from package.json**

```bash
cd backend && npm uninstall express-basic-auth
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: rewire index.js for JWT auth and tenant-scoped endpoints"
```

---

### Task 6: Backend — Tenant-scoped operationBot.js

**Files:**
- Modify: `backend/bots/operationBot.js`

- [ ] **Step 1: Convert global maps to tenant-keyed**

Change:
```javascript
let operationBots = {};
let groupBots = {};
const groupCache = new Map();
```
to:
```javascript
// operationBots[tenantId][botId] = sock
let operationBots = {};
// groupBots[tenantId][groupId] = [botId, ...]
let groupBots = {};
// groupCache[tenantId] = Map(groupId → { id, name, member_count, bots })
let groupCache = {};
```

- [ ] **Step 2: Update all functions to accept tenantId parameter**

Every function signature changes:
- `connectBot(botId, opts)` → opts includes `tenantId`
- `getNextBotForGroup(groupId, tenantId)`
- `getAllGroups(tenantId)`
- `updateGroupCache(botId, sock, tenantId)`
- `disconnectBotForce(botId, tenantId)`
- `stopOperationBot(botId, tenantId)`
- `getBotStatusList(tenantId)`
- `startOperationBotAPI(botId, tenantId)`
- `reconnectBot(tenantId)` — if tenantId given, reconnect only that tenant's bots; if null, reconnect all
- `reconnectSingleBot(botId, tenantId)`

All internal access patterns change from `operationBots[botId]` to `operationBots[tenantId]?.[botId]`.

- [ ] **Step 3: Update updateBotStatus to write DB instead of file**

```javascript
async function updateBotStatusDB(botId, status, tenantId) {
    try {
        await query(
            `INSERT INTO bot_status (tenant_id, bot_id, status, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (tenant_id, bot_id) DO UPDATE SET status = $3, updated_at = NOW()`,
            [tenantId, botId, status]
        );
    } catch (err) {
        console.error('Bot status DB error:', err.message);
    }

    // Emit to dashboard
    if (status === 'open' || status === 'close') {
        try {
            const { io } = require('../index');
            if (io && tenantId) {
                io.to(`tenant:${tenantId}`).emit('bot:status', { botId, status, timestamp: new Date().toISOString() });
            }
        } catch (e) {}
    }
}
```

- [ ] **Step 4: Update getBotStatusMap to query DB**

```javascript
async function getBotStatusMap(tenantId) {
    try {
        const result = await query('SELECT bot_id, status FROM bot_status WHERE tenant_id = $1', [tenantId]);
        const map = {};
        result.rows.forEach(r => { map[r.bot_id] = r.status; });
        return map;
    } catch (err) {
        return {};
    }
}
```

- [ ] **Step 5: Update auth_sessions path to include tenantId**

```javascript
const AUTH_FOLDER = path.join(__dirname, '..', 'auth_sessions', tenantId, botId);
```

- [ ] **Step 6: Update reconnectBot to load from DB**

Instead of reading `auth_sessions/` directory, query `bot_status` table:
```javascript
async function reconnectBot(tenantId) {
    const result = await query(
        'SELECT bot_id, is_admin_bot FROM bot_status WHERE tenant_id = $1',
        [tenantId]
    );
    for (const row of result.rows) {
        if (!row.is_admin_bot) {
            await connectBot(row.bot_id, { tenantId });
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}
```

- [ ] **Step 7: Update module.exports**

All exported functions now accept `tenantId`.

- [ ] **Step 8: Commit**

```bash
git add backend/bots/operationBot.js
git commit -m "feat: tenant-scope operationBot — per-tenant bot/group isolation"
```

---

### Task 7: Backend — Tenant-scoped adminBot.js + custom commands

**Files:**
- Modify: `backend/bots/adminBot.js`

- [ ] **Step 1: Load tenant context from DB when admin bot receives a message**

When a message comes in, look up which tenant owns this admin bot:
```javascript
async function getTenantByAdminBot(botId) {
    const result = await query('SELECT t.* FROM tenants t WHERE t.admin_bot_id = $1 AND t.is_active = TRUE', [botId]);
    return result.rows[0] || null;
}
```

- [ ] **Step 2: Replace hardcoded brand name with tenant's brand_name**

In all command responses, replace `*ZYRON*` or `*${BRAND}*` with `*${tenant.brand_name}*`:
```javascript
const brand = tenant.brand_name;
// e.g. `*${brand}* Bot *${botName}* is being added...`
```

- [ ] **Step 3: Add custom command handler in message processing**

After system command checks, before ignoring the message:
```javascript
// Check custom commands
const customCmd = await query(
    'SELECT response_template FROM custom_commands WHERE tenant_id = $1 AND command = $2',
    [tenant.id, text.split(' ')[0]]
);

if (customCmd.rows.length > 0) {
    const template = customCmd.rows[0].response_template;
    const metadata = await sock.groupMetadata(chatId).catch(() => null);
    const statusMap = await getBotStatusMap(tenant.id);
    const onlineCount = Object.values(statusMap).filter(s => s === 'open').length;

    const response = template
        .replace(/\{brand\}/g, tenant.brand_name)
        .replace(/\{date\}/g, new Date().toLocaleDateString('id-ID'))
        .replace(/\{time\}/g, new Date().toLocaleTimeString('id-ID'))
        .replace(/\{group_name\}/g, metadata?.subject || 'Unknown')
        .replace(/\{group_id\}/g, chatId)
        .replace(/\{bot_count\}/g, String(onlineCount))
        .replace(/\{member_count\}/g, String(metadata?.participants?.length || 0))
        .replace(/\{sender\}/g, message.key.participant?.split('@')[0] || 'Unknown');

    await sock.sendMessage(chatId, { text: response });
}
```

- [ ] **Step 4: Pass tenantId to all operationBot calls**

```javascript
startOperationBot(botName, sock, chatId, tenant.id);
reconnectSingleBotCommand(botName, tenant.id);
stopOperationBot(botNumber, tenant.id);
// etc.
```

- [ ] **Step 5: Support multiple admin bots (one per tenant)**

Change from single `startAdminBot()` to `startAdminBots()` that loads all tenants and starts their admin bots:
```javascript
async function startAdminBots() {
    const result = await query('SELECT * FROM tenants WHERE admin_bot_id IS NOT NULL AND is_active = TRUE');
    for (const tenant of result.rows) {
        await startSingleAdminBot(tenant);
        await new Promise(r => setTimeout(r, 3000));
    }
}
```

- [ ] **Step 6: Commit**

```bash
git add backend/bots/adminBot.js
git commit -m "feat: tenant-scoped admin bot with custom commands and brand personalization"
```

---

### Task 8: Backend — Update statmanager & docker-compose

**Files:**
- Modify: `backend/utils/statmanager.js`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add tenantId to statmanager**

Update `increment` and `getStatsByDate`:
```javascript
async function increment(botName, tenantId) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hour = now.getHours();

    try {
        await query(
            `INSERT INTO message_stats (tenant_id, bot_name, date, hour, count)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (tenant_id, bot_name, date, hour)
             DO UPDATE SET count = message_stats.count + 1`,
            [tenantId, botName, date, hour]
        );
    } catch (err) {
        console.error('Stats increment error:', err.message);
    }
}

async function getStatsByDate(date, tenantId) {
    try {
        const result = await query(
            'SELECT hour, bot_name, count FROM message_stats WHERE date = $1 AND tenant_id = $2 ORDER BY hour',
            [date, tenantId]
        );
        const stats = {};
        for (const row of result.rows) {
            const hourKey = String(row.hour).padStart(2, '0');
            if (!stats[hourKey]) stats[hourKey] = {};
            stats[hourKey][row.bot_name] = row.count;
        }
        return stats;
    } catch (err) {
        return {};
    }
}
```

- [ ] **Step 2: Update docker-compose.yml**

Add env vars to backend service:
```yaml
    environment:
      - NODE_ENV=production
      - DB_HOST=db
      - DB_PORT=5432
      - DB_NAME=wabot
      - DB_USER=wabot
      - DB_PASSWORD=wabot123
      - JWT_SECRET=your-secret-here-change-in-production
      - SUPER_ADMIN_USER=admin
      - SUPER_ADMIN_PASSWORD=admin123
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: tenant-scoped stats manager and docker-compose env vars"
```

---

### Task 9: Frontend — Rewrite auth for JWT

**Files:**
- Modify: `frontend/src/lib/auth.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/socket.ts`
- Modify: `frontend/src/components/Login.tsx`
- Modify: `frontend/src/components/ProtectedRoute.tsx`

- [ ] **Step 1: Rewrite frontend/src/lib/auth.ts**

```typescript
const TOKEN_KEY = 'wa-bot-token';

export interface UserPayload {
  userId: string;
  tenantId: string | null;
  role: 'super_admin' | 'admin';
  brandName: string;
  exp: number;
}

export function setToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function getAuthHeader(): string | null {
  const token = getToken();
  if (!token) return null;
  return `Bearer ${token}`;
}

export function getUser(): UserPayload | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      clearToken();
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getUser() !== null;
}

export function isSuperAdmin(): boolean {
  return getUser()?.role === 'super_admin';
}
```

- [ ] **Step 2: Update frontend/src/lib/api.ts**

Change `getAuthHeader` import from `./auth` and remove `clearCredentials`:
```typescript
import { getAuthHeader, clearToken } from './auth';
```

Replace `clearCredentials()` with `clearToken()` in the 401 handler.

- [ ] **Step 3: Update frontend/src/lib/socket.ts**

```typescript
import { io, Socket } from 'socket.io-client';
import { getToken, isAuthenticated } from './auth';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  if (!isAuthenticated()) return null;
  if (socket) return socket;

  socket = io({
    auth: { token: getToken() },
    transports: ['websocket'],
    reconnectionDelay: 5000,
    reconnectionAttempts: 10,
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
```

- [ ] **Step 4: Rewrite Login.tsx for JWT**

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { setToken } from '@/lib/auth';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok && data.token) {
        setToken(data.token);
        onLogin();
      } else {
        setError(data.error || 'Invalid credentials');
      }
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center">Dashboard Login</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" value={username} onChange={e => setUsername(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Logging in...' : 'Login'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Update ProtectedRoute.tsx**

```tsx
import { isAuthenticated } from '@/lib/auth';
import { Login } from './Login';

export function ProtectedRoute({ children, onLogin }: { children: React.ReactNode; onLogin: () => void }) {
  if (!isAuthenticated()) {
    return <Login onLogin={onLogin} />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: frontend JWT auth — login, token storage, API/socket integration"
```

---

### Task 10: Frontend — Layout with dynamic brand & role-based nav

**Files:**
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Update Layout.tsx**

Import `getUser, isSuperAdmin, clearToken` from auth. Add conditional nav items:

```typescript
import { clearToken, getUser, isSuperAdmin } from '@/lib/auth';

// In the component:
const user = getUser();
const brandName = user?.brandName || 'Dashboard';

// Nav items — conditionally include super admin and command pages
const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/bots', label: 'Bot Management', icon: Bot },
  { path: '/send', label: 'Send Message', icon: Send },
  { path: '/groups', label: 'Groups', icon: Users },
  { path: '/failed', label: 'Failed Requests', icon: AlertTriangle },
  { path: '/stats', label: 'Statistics', icon: BarChart3 },
  { path: '/logs', label: 'Logs', icon: FileText },
  ...(user?.tenantId ? [{ path: '/commands', label: 'Custom Commands', icon: Terminal }] : []),
  ...(isSuperAdmin() ? [{ path: '/tenants', label: 'Tenants', icon: Building2 }] : []),
];
```

Use `brandName` in sidebar title: `<h1 className="text-lg font-bold">{brandName}</h1>`

Replace `clearCredentials()` with `clearToken()` in handleLogout.

Add `Terminal, Building2` to lucide-react imports.

- [ ] **Step 2: Update App.tsx with new routes**

```tsx
import TenantManagement from '@/pages/TenantManagement';
import CustomCommands from '@/pages/CustomCommands';

// In Routes:
<Route path="/commands" element={<CustomCommands />} />
<Route path="/tenants" element={<TenantManagement />} />
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: dynamic brand name in sidebar, role-based navigation"
```

---

### Task 11: Frontend — Tenant Management Page (super admin)

**Files:**
- Create: `frontend/src/pages/TenantManagement.tsx`

- [ ] **Step 1: Create TenantManagement.tsx**

Page with:
- Table: name, brand_name, bot_count, user_count, is_active, created_at
- Create form (dialog): name, brand_name, username, password
- Edit: update name, brand_name, toggle active
- Delete: deactivate button with confirm
- Guard: if not super_admin, show "Access denied"

Full implementation with `fetchApi`/`postApi` calls to `/tenants` endpoints. Use plain HTML tables (consistent with Groups page pattern). Badge for active/inactive status.

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Tenant Management page for super admin"
```

---

### Task 12: Frontend — Custom Commands Page

**Files:**
- Create: `frontend/src/pages/CustomCommands.tsx`

- [ ] **Step 1: Create CustomCommands.tsx**

Page with:
- Table: command, template preview (truncated), created_at, actions
- Create form (dialog): command name input (with `!` prefix hint), response_template textarea
- Variable hints shown below textarea: `{brand}`, `{date}`, `{time}`, `{group_name}`, `{group_id}`, `{bot_count}`, `{member_count}`, `{sender}`
- Edit/Delete per row
- Preview section: render template with sample values
- Guard: if super_admin (no tenant), show "Select a tenant first"

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Custom Commands page with template preview"
```

---

### Task 13: Update CLAUDE.md & docker-compose

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Update CLAUDE.md**

Add multi-tenancy section documenting:
- JWT auth flow
- Tenant isolation
- Super admin vs tenant admin roles
- Custom commands
- New env vars

- [ ] **Step 2: Final docker-compose.yml update**

Ensure all new env vars are present.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md and docker-compose for multi-tenancy"
```
