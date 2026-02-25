/**
 * KaspaNotary - Blockchain Document Reconstruction Service
 * 
 * Retrieves and reassembles documents from the Kaspa blockchain using
 * only the public REST API. No wallet, no RPC, no Keystone dependency.
 * 
 * Given a manifest transaction ID, this service:
 *   1. Fetches the manifest TX payload and parses the kaspanotary header
 *   2. Extracts chunk TX IDs from the manifest JSON
 *   3. Fetches each chunk TX and strips the protocol header
 *   4. Reassembles the original file from ordered chunk data
 *   5. Verifies the SHA-256 hash matches the on-chain record
 * 
 * This proves KaspaNotary documents are independently recoverable
 * without relying on any centralized infrastructure.
 * 
 * Protocol: "kaspanotary" v1
 * License: Apache-2.0
 */

const crypto = require('crypto');

const KASPA_API = process.env.KASPA_API_URL || 'https://api.kaspa.org';

const PROTOCOL_TAG = 'kaspanotary';
const TYPE_DATA_CHUNK = 0x01;
const TYPE_MANIFEST = 0x02;


// ─────────────────────────────────────────────
//  Parse a kaspanotary protocol payload
// ─────────────────────────────────────────────

/**
 * Parse a kaspanotary protocol payload from raw hex bytes.
 * 
 * Header format (binary):
 *   [1 byte]   tag length
 *   [N bytes]  tag string ("kaspanotary")
 *   [1 byte]   protocol version
 *   [1 byte]   type: 0x01 = data chunk, 0x02 = manifest
 *   [2 bytes]  chunk index (uint16 LE)
 *   [2 bytes]  total chunks (uint16 LE)
 *   [32 bytes] file SHA-256 hash
 *   [rest]     payload data
 */
function parsePayload(buf) {
    let offset = 0;

    const tagLen = buf.readUInt8(offset); offset += 1;
    const tag = buf.slice(offset, offset + tagLen).toString('utf8'); offset += tagLen;
    const version = buf.readUInt8(offset); offset += 1;
    const type = buf.readUInt8(offset); offset += 1;
    const chunkIndex = buf.readUInt16LE(offset); offset += 2;
    const totalChunks = buf.readUInt16LE(offset); offset += 2;
    const fileHash = buf.slice(offset, offset + 32).toString('hex'); offset += 32;
    const data = buf.slice(offset);

    return { tag, version, type, chunkIndex, totalChunks, fileHash, data };
}


// ─────────────────────────────────────────────
//  Fetch transaction from Kaspa public REST API
// ─────────────────────────────────────────────

/**
 * Fetch a single transaction by ID.
 * Uses the public Kaspa REST API - no auth, no wallet, no RPC.
 */
async function fetchTransaction(txId) {
    const url = `${KASPA_API}/transactions/${txId}?inputs=true&outputs=true&resolve_previous_outpoints=no`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Kaspa API error: ${response.status} ${response.statusText} for TX ${txId}`);
    }

    return response.json();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// ─────────────────────────────────────────────
//  Retrieve & verify a document (direct, no SSE)
// ─────────────────────────────────────────────

/**
 * Retrieve a notarized document from the Kaspa blockchain.
 * Returns the reassembled file as a Buffer. For the animated version, use streamReconstruction().
 */
async function reconstructDocument(manifestTxId, opts = {}) {
    const manifestTx = await fetchTransaction(manifestTxId);

    if (!manifestTx.payload) {
        throw new Error('Transaction has no payload - not a kaspanotary manifest');
    }

    const manifestBuf = Buffer.from(manifestTx.payload, 'hex');
    const parsed = parsePayload(manifestBuf);

    if (parsed.tag !== PROTOCOL_TAG) throw new Error(`Unknown protocol: "${parsed.tag}"`);
    if (parsed.type !== TYPE_MANIFEST) throw new Error('Not a manifest transaction');

    const manifest = JSON.parse(parsed.data.toString('utf8'));
    if (!manifest.chunkTxIds || !manifest.chunkTxIds.length) throw new Error('No chunk TXs in manifest');

    console.log(`[Reconstruct] Retrieving "${manifest.title}" - ${manifest.chunkCount} chunk(s), ${manifest.fileSize} bytes`);

    const chunkBuffers = [];

    for (let i = 0; i < manifest.chunkTxIds.length; i++) {
        const chunkTx = await fetchTransaction(manifest.chunkTxIds[i]);
        if (!chunkTx.payload) throw new Error(`Chunk ${i} has no payload`);

        const chunkBuf = Buffer.from(chunkTx.payload, 'hex');
        const chunkParsed = parsePayload(chunkBuf);
        if (chunkParsed.type !== TYPE_DATA_CHUNK) throw new Error(`Chunk ${i}: wrong type`);

        chunkBuffers.push(chunkParsed.data);

        if (opts.onProgress) opts.onProgress(i + 1, manifest.chunkTxIds.length, manifest.chunkTxIds[i]);
    }

    const file = Buffer.concat(chunkBuffers);
    const computedHash = crypto.createHash('sha256').update(file).digest('hex');
    const verified = computedHash === manifest.fileHash;

    if (verified) {
        console.log(`[Reconstruct] ✓ Verified - Hash: ${manifest.fileHash}`);
    } else {
        console.warn(`[Reconstruct] ✗ HASH MISMATCH - Expected: ${manifest.fileHash}, Got: ${computedHash}`);
    }

    return { file, manifest, verified, fileHash: manifest.fileHash, totalChunks: manifest.chunkTxIds.length };
}


// ─────────────────────────────────────────────
//  SSE streaming reconstruction (animated)
// ─────────────────────────────────────────────

/**
 * Stream the reconstruction process over Server-Sent Events.
 * Sends real-time progress as each chunk is fetched from the blockchain,
 * giving the user a live view of the reconstruction.
 * 
 * Events emitted:
 *   manifest  - { title, fileName, fileSize, fileHash, chunkCount }
 *   chunk     - { index, total, txId, percent, bytesReceived }
 *   verifying - { fileHash }
 *   complete  - { verified, fileHash, totalChunks, fileBase64, fileName, fileType }
 *   error     - { message }
 */
async function streamReconstruction(manifestTxId, res) {
    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    function send(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
        // 1. Fetch & parse manifest
        send('status', { message: 'Fetching manifest transaction...' });

        const manifestTx = await fetchTransaction(manifestTxId);
        if (!manifestTx.payload) throw new Error('Transaction has no payload');

        const manifestBuf = Buffer.from(manifestTx.payload, 'hex');
        const parsed = parsePayload(manifestBuf);

        if (parsed.tag !== PROTOCOL_TAG) throw new Error(`Unknown protocol: "${parsed.tag}"`);
        if (parsed.type !== TYPE_MANIFEST) throw new Error('Not a manifest transaction');

        const manifest = JSON.parse(parsed.data.toString('utf8'));
        if (!manifest.chunkTxIds || !manifest.chunkTxIds.length) throw new Error('No chunk TXs in manifest');

        console.log(`[Reconstruct] SSE stream: "${manifest.title}" - ${manifest.chunkCount} chunk(s)`);

        send('manifest', {
            title: manifest.title,
            fileName: manifest.fileName,
            fileSize: manifest.fileSize,
            fileHash: manifest.fileHash,
            chunkCount: manifest.chunkCount,
        });

        // Pacing: 100ms small files, 75ms medium, 50ms large
        const delay = manifest.chunkTxIds.length > 20 ? 50 :
                      manifest.chunkTxIds.length > 5  ? 75 : 100;

        // 2. Fetch chunks with live progress
        const chunkBuffers = [];
        let bytesReceived = 0;

        for (let i = 0; i < manifest.chunkTxIds.length; i++) {
            const chunkTxId = manifest.chunkTxIds[i];
            const chunkTx = await fetchTransaction(chunkTxId);

            if (!chunkTx.payload) throw new Error(`Chunk ${i} has no payload`);

            const chunkBuf = Buffer.from(chunkTx.payload, 'hex');
            const chunkParsed = parsePayload(chunkBuf);
            if (chunkParsed.type !== TYPE_DATA_CHUNK) throw new Error(`Chunk ${i}: wrong type`);

            chunkBuffers.push(chunkParsed.data);
            bytesReceived += chunkParsed.data.length;

            const percent = Math.round(((i + 1) / manifest.chunkTxIds.length) * 100);

            send('chunk', {
                index: i + 1,
                total: manifest.chunkTxIds.length,
                txId: chunkTxId,
                percent,
                bytesReceived,
            });

            // Pacing delay between chunks (skip after last)
            if (i < manifest.chunkTxIds.length - 1) {
                await sleep(delay);
            }
        }

        // 3. Verify
        send('verifying', { fileHash: manifest.fileHash });
        await sleep(400);

        const file = Buffer.concat(chunkBuffers);
        const computedHash = crypto.createHash('sha256').update(file).digest('hex');
        const verified = computedHash === manifest.fileHash;

        console.log(`[Reconstruct] SSE complete: verified=${verified}`);

        // 4. Send the assembled file
        send('complete', {
            verified,
            fileHash: manifest.fileHash,
            totalChunks: manifest.chunkTxIds.length,
            fileBase64: file.toString('base64'),
            fileName: manifest.fileName || 'document.pdf',
            fileType: manifest.fileType || 'application/pdf',
        });

        res.end();

    } catch (err) {
        console.error('[Reconstruct] SSE error:', err.message);
        send('error', { message: err.message });
        res.end();
    }
}


// ─────────────────────────────────────────────
//  Fetch manifest metadata only
// ─────────────────────────────────────────────

async function fetchManifest(manifestTxId) {
    const tx = await fetchTransaction(manifestTxId);
    if (!tx.payload) throw new Error('Transaction has no payload');

    const buf = Buffer.from(tx.payload, 'hex');
    const parsed = parsePayload(buf);

    if (parsed.tag !== PROTOCOL_TAG || parsed.type !== TYPE_MANIFEST) {
        throw new Error('Not a kaspanotary manifest transaction');
    }

    return JSON.parse(parsed.data.toString('utf8'));
}


module.exports = {
    reconstructDocument,
    streamReconstruction,
    fetchManifest,
    fetchTransaction,
    parsePayload,
};
