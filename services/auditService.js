const db = require('../db');

/**
 * Log an action to the audit table
 */
async function log(docUuid, walletAddress, action, details, ipAddress) {
    try {
        await db.execute(
            'INSERT INTO notary_audit_log (doc_uuid, wallet_address, action, details, ip_address) VALUES (?, ?, ?, ?, ?)',
            [docUuid, walletAddress, action, details ? JSON.stringify(details) : null, ipAddress || null]
        );
    } catch (err) {
        console.error('Audit log error:', err.message);
    }
}

module.exports = { log };
