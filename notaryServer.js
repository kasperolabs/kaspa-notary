require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const notaryRoutes = require('./routes/notaryRoutes');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3200;

// Security
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false
}));

app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? [process.env.APP_URL, 'https://kaspanotary.com']
        : true,
    credentials: true
}));

// Trust nginx proxy
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Stricter limit for auth only
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: 'Too many requests, please try again later' }
});
app.use('/api/auth/', authLimiter);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', notaryRoutes);

// SPA fallback — serve index.html for frontend routes
app.get('/invite/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/proof/:docUuid', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/document/:docUuid', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/api/health', async (req, res) => {
    try {
        await db.execute('SELECT 1');
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'error', error: 'Database connection failed' });
    }
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    if (err.message === 'Only PDF files are accepted') {
        return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`KaspaNotary server running on port ${PORT}`);
});
