const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.SESSION_SECRET || 'change-me';

/**
 * Generate a JWT for a wallet address
 */
function generateToken(walletAddress) {
    return jwt.sign({ wallet: walletAddress }, JWT_SECRET, { expiresIn: '24h' });
}

/**
 * Verify JWT and attach wallet address to req
 */
function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

/**
 * Express middleware: require authenticated user
 * Sets req.walletAddress
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = verifyToken(token);
        req.walletAddress = decoded.wallet;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

/**
 * Express middleware: optional auth (for invite links)
 * Sets req.walletAddress if token present, otherwise null
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const token = authHeader.split(' ')[1];
            const decoded = verifyToken(token);
            req.walletAddress = decoded.wallet;
        } catch (err) {
            req.walletAddress = null;
        }
    } else {
        req.walletAddress = null;
    }
    next();
}

module.exports = {
    generateToken,
    verifyToken,
    requireAuth,
    optionalAuth
};
