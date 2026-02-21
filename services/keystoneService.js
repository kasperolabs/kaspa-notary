/**
 * Keystone Transaction Service — Single TX, Structured Payload
 * 
 * Payload format: NOTARY:1|partyA_wallet|partyB_wallet|sha256_of_pdf
 * 
 * Anyone reading the TX can split on '|' and see:
 *   [0] NOTARY:1       — protocol header (notary seal, version 1)
 *   [1] kaspa:qr...    — Party A wallet address
 *   [2] kaspa:qr...    — Party B wallet address
 *   [3] a1b2c3d4...    — SHA-256 hash of the original PDF
 */

const KEYSTONE_API_URL = process.env.KEYSTONE_API_URL;
const KEYSTONE_API_KEY = process.env.KEYSTONE_API_KEY;

/**
 * Build the structured payload string
 */
function buildPayload(partyAWallet, partyBWallet, pdfHash) {
    return ['NOTARY:1', partyAWallet, partyBWallet, pdfHash].join('|');
}

/**
 * Send the seal transaction with structured payload.
 * This is the ONLY blockchain transaction in the notary flow.
 * 
 * @param {string} partyAWallet - Creator's Kaspa address
 * @param {string} partyBWallet - Counterparty's Kaspa address
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
    if (!data.success) {
        throw new Error(data.error || 'Keystone transaction failed');
    }

    return { txId: data.txid, payload };
}

module.exports = { sendSealTx, buildPayload };
