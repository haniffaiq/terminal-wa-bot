// authMiddleware.js
const basicAuth = require('express-basic-auth');

// Setup Basic Auth Middleware
const authMiddleware = basicAuth({
    users: { 'wa-ops': 'wapass@2021' }, // ðŸ”’ Ganti username dan password sesuai kebutuhan
    challenge: true,
    unauthorizedResponse: (req) => 'Unauthorized'
});

module.exports = authMiddleware;
