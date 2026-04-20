const { verifyToken } = require('./auth');

function authMiddleware(req, res, next) {
    if (req.path === '/api/auth/login' || req.path === '/api/webhook/send') return next();

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
