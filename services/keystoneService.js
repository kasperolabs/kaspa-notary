/**
 * Keystone Transaction Service — Single TX, Structured Payload
 * 
 * Two-party payload:   NOTARY:1|partyA_wallet|partyB_wallet|sha256_of_pdf
 * Single-signer payload: NOTARY:1|partyA_wallet|SELF|sha256_of_pdf
 * 
 * Anyone reading the TX can split on '|' and see:
 *   [0] NOTARY:1       — protocol header (notary seal, version 1)
 *   [1] kaspa:qr...    — Party A wallet address
 *   [2] kaspa:qr... or SELF — Party B wallet address (SELF = single signer)
 *   [3] a1b2c3d4...    — SHA-256 hash of the original PDF
 */

const KEYSTONE_API_URL = process.env.KEYSTONE_API_URL;
const KEYSTONE_API_KEY = process.env.KEYSTONE_API_KEY;

/**
 * Build the structured payload string
 * @param {string} partyAWallet - Creator's Kaspa address
 * @param {string|null} partyBWallet - Counterparty's Kaspa address, or null for single-signer
 * @param {string} pdfHash - SHA-256 hex string (64 chars)
 */
function buildPayload(partyAWallet, partyBWallet, pdfHash) {
    return ['NOTARY:1', partyAWallet, partyBWallet || 'SELF', pdfHash].join('|');
}

/**
 * Extract a transaction ID from a mempool duplicate error message.
 * Kaspa returns: "Rejected transaction <txid>: transaction <txid> is already in the mempool"
 * This means the TX actually succeeded — it's already been accepted.
 */
function extractMempoolTxId(errorMsg) {
    if (!errorMsg || !errorMsg.includes('already in the mempool')) return null;
    const match = errorMsg.match(/Rejected transaction ([a-f0-9]{64})/);
    return match ? match[1] : null;
}

/**
 * Send the seal transaction with structured payload.
 * This is the ONLY blockchain transaction in the notary flow.
 * 
 * Handles the "already in mempool" edge case where the Keystone API
 * returns an error even though the TX was actually accepted.
 * 
 * @param {string} partyAWallet - Creator's Kaspa address
 * @param {string|null} partyBWallet - Counterparty's Kaspa address, or null for single-signer
 * @param {string} pdfHash - SHA-256 hex string (64 chars) of the original PDF
 * @returns {Promise<{ txId: string, payload: string }>}
 */
async function sendSealTx(partyAWallet, partyBWallet, pdfHash) {
    if (!KEYSTONE_API_URL || !KEYSTONE_API_KEY) {
        throw new Error('Keystone API not configured — set KEYSTONE_API_URL and KEYSTONE_API_KEY in .env');
    }

    const payload = buildPayload(partyAWallet, partyBWallet, pdfHash);

    const response = await fetch(`${KEYSTONE_API_URL}/api/notary/send-hash`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Notary-Secret': KEYSTONE_API_KEY
        },
        body: JSON.stringify({ payload })
    });

    const data = await response.json();
    
    if (data.success) {
        return { txId: data.txid, payload };
    }

    // Check if this is an "already in mempool" error — TX actually succeeded
    const errorStr = typeof data.error === 'string' ? data.error : JSON.stringify(data.error || '');
    const mempoolTxId = extractMempoolTxId(errorStr);
    if (mempoolTxId) {
        console.log('Seal TX already in mempool (treating as success):', mempoolTxId);
        return { txId: mempoolTxId, payload };
    }

    throw new Error(data.error || 'Keystone transaction failed');
}

module.exports = { sendSealTx, buildPayload };
