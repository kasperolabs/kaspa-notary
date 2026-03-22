/**
 * Kasla Transaction Service - Seal TX + On-Chain File Embedding
 * 
 * Seal payload (hash anchor):
 *   Two-party:       NOTARY:1|partyA_wallet|partyB_wallet|sha256_of_pdf
 *   Single-signer:   NOTARY:1|partyA_wallet|SELF|sha256_of_pdf
 * 
 * File embedding:
 *   Delegates to Kasla's notaryChain service which chunks the file
 *   into ~22KB transactions, submits each sequentially, then submits
 *   a manifest transaction containing all chunk TXIDs.
 *   Kasla handles wallet management, UTXO sync, and retry logic.
 */

const KASLA_API_URL = process.env.KASLA_API_URL;
const KASLA_API_KEY = process.env.KASLA_API_KEY;

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
 */
function extractMempoolTxId(errorMsg) {
    if (!errorMsg || !errorMsg.includes('already in the mempool')) return null;
    const match = errorMsg.match(/Rejected transaction ([a-f0-9]{64})/);
    return match ? match[1] : null;
}

/**
 * Send the seal transaction with structured payload.
 * This is the primary blockchain transaction in the notary flow.
 */
async function sendSealTx(partyAWallet, partyBWallet, pdfHash) {
    if (!KASLA_API_URL || !KASLA_API_KEY) {
        throw new Error('Kasla API not configured - set KASLA_API_URL and KASLA_API_KEY in .env');
    }

    const payload = buildPayload(partyAWallet, partyBWallet, pdfHash);

    const response = await fetch(`${KASLA_API_URL}/api/notary/send-hash`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Notary-Secret': KASLA_API_KEY
        },
        body: JSON.stringify({ payload })
    });

    const data = await response.json();
    
    if (data.success) {
        return { txId: data.txid, payload };
    }

    const errorStr = typeof data.error === 'string' ? data.error : JSON.stringify(data.error || '');
    const mempoolTxId = extractMempoolTxId(errorStr);
    if (mempoolTxId) {
        console.log('Seal TX already in mempool (treating as success):', mempoolTxId);
        return { txId: mempoolTxId, payload };
    }

    throw new Error(data.error || 'Kasla transaction failed');
}


// ─────────────────────────────────────────────
// ON-CHAIN FILE EMBEDDING
// ─────────────────────────────────────────────

/**
 * Request Kasla to embed a file on the blockDAG.
 * 
 * Sends the file as base64 to Kasla's embed-file endpoint.
 * Kasla chunks it, submits transactions, and returns a job ID.
 * The caller polls checkEmbedStatus() for progress.
 * 
 * @param {Buffer} fileBuffer - The raw PDF file
 * @param {Object} metadata - Document metadata for the manifest
 * @param {string} metadata.title - Document title
 * @param {string} metadata.fileName - Original filename
 * @param {string} metadata.fileHash - SHA-256 hex of the file
 * @param {number} metadata.fileSize - File size in bytes
 * @param {string} metadata.creatorAddress - Creator's Kaspa address
 * @param {string|null} metadata.counterpartyAddress - Counterparty's address
 * @param {string|null} metadata.creatorSignature - Creator's Schnorr sig (JSON string)
 * @param {string|null} metadata.counterpartySignature - Counterparty's Schnorr sig (JSON string)
 * @param {string|null} metadata.note - Optional note
 * @returns {Promise<{ jobId: string, estimatedChunks: number, estimatedCostKas: number }>}
 */
async function requestFileEmbed(fileBuffer, metadata) {
    if (!KASLA_API_URL || !KASLA_API_KEY) {
        throw new Error('Kasla API not configured');
    }

    const response = await fetch(`${KASLA_API_URL}/api/notary/embed-file`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Notary-Secret': KASLA_API_KEY
        },
        body: JSON.stringify({
            fileBase64: fileBuffer.toString('base64'),
            title: metadata.title,
            fileName: metadata.fileName,
            fileHash: metadata.fileHash,
            fileSize: metadata.fileSize,
            fileType: metadata.fileType || 'application/pdf',
            creatorAddress: metadata.creatorAddress,
            counterpartyAddress: metadata.counterpartyAddress || null,
            creatorSignature: metadata.creatorSignature || null,
            counterpartySignature: metadata.counterpartySignature || null,
            note: metadata.note || null,
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Kasla embed-file failed (${response.status}): ${text}`);
    }

    const data = await response.json();

    if (!data.success) {
        throw new Error(data.error || 'Kasla embed-file request failed');
    }

    return {
        jobId: data.jobId,
        estimatedChunks: data.estimatedChunks || null,
        estimatedCostKas: data.estimatedCostKas || null,
    };
}


/**
 * Check the status of a file embedding job on Kasla.
 * 
 * @param {string} jobId - The job ID returned by requestFileEmbed
 * @returns {Promise<EmbedStatus>}
 * 
 * @typedef {Object} EmbedStatus
 * @property {string} status - 'pending' | 'embedding' | 'confirmed' | 'failed'
 * @property {number|null} chunksCompleted - Number of chunks submitted so far
 * @property {number|null} chunksTotal - Total chunks expected
 * @property {string|null} manifestTxId - Manifest TX ID (set when confirmed)
 * @property {string[]|null} chunkTxIds - Array of chunk TX IDs (set when confirmed)
 * @property {number|null} actualCostKas - Actual cost in KAS (set when confirmed)
 * @property {string|null} error - Error message (set when failed)
 */
async function checkEmbedStatus(jobId) {
    if (!KASLA_API_URL || !KASLA_API_KEY) {
        throw new Error('Kasla API not configured');
    }

    const response = await fetch(`${KASLA_API_URL}/api/notary/embed-status/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: {
            'X-Notary-Secret': KASLA_API_KEY
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Kasla embed-status failed (${response.status}): ${text}`);
    }

    const data = await response.json();

    if (!data.success) {
        throw new Error(data.error || 'Kasla embed-status request failed');
    }

    return {
        status: data.status,
        chunksCompleted: data.chunksCompleted ?? null,
        chunksTotal: data.chunksTotal ?? null,
        manifestTxId: data.manifestTxId || null,
        chunkTxIds: data.chunkTxIds || null,
        actualCostKas: data.actualCostKas ?? null,
        error: data.error || null,
    };
}


module.exports = { sendSealTx, buildPayload, requestFileEmbed, checkEmbedStatus };
