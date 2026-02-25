const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('../db');
const { requireAuth, optionalAuth, generateToken } = require('../middleware/auth');
const notaryService = require('../services/notaryService');
const keystoneService = require('../services/keystoneService');
const emailService = require('../services/emailService');
const audit = require('../services/auditService');
const reconstructService = require('../services/reconstructService');

const APP_URL = process.env.APP_URL || 'https://kaspanotary.com';
const NOTARY_FEE_KAS = parseFloat(process.env.NOTARY_FEE_KAS) || 5;

// ─────────────────────────────────────────────
// HELPER: Trigger on-chain file embedding (fire-and-forget)
// ─────────────────────────────────────────────

/**
 * If the document has upload_to_chain enabled, request Keystone
 * to embed the actual file on the blockDAG. Runs asynchronously
 * after the seal TX has been confirmed - does not block the response.
 * 
 * @param {string} docUuid - Document UUID
 * @param {Object} doc - Document row from DB (must include upload_to_chain, original_file_path, etc.)
 */
async function triggerChainEmbed(docUuid, doc) {
    if (!doc.upload_to_chain) return;

    try {
        // Atomic dedup: only proceed if chain_status is still 'none'
        // This prevents double-calls from racing
        const [result] = await db.execute(
            `UPDATE notary_documents SET chain_status = 'pending' WHERE doc_uuid = ? AND chain_status = 'none'`,
            [docUuid]
        );
        if (result.affectedRows === 0) {
            console.log(`[Notary] Chain embed already in progress or completed for ${docUuid}, skipping`);
            return;
        }

        // Read the file from disk
        const fs = require('fs').promises;
        const fileBuffer = await fs.readFile(doc.original_file_path);

        // Parse signatures for manifest metadata
        let creatorSig = null;
        let counterpartySig = null;
        try { creatorSig = typeof doc.creator_signature === 'string' ? doc.creator_signature : JSON.stringify(doc.creator_signature); } catch (e) {}
        try { counterpartySig = typeof doc.counterparty_signature === 'string' ? doc.counterparty_signature : JSON.stringify(doc.counterparty_signature); } catch (e) {}

        const embedResult = await keystoneService.requestFileEmbed(fileBuffer, {
            title: doc.title,
            fileName: doc.title + '.pdf',
            fileHash: doc.original_hash,
            fileSize: doc.file_size,
            fileType: 'application/pdf',
            creatorAddress: doc.creator_wallet_address,
            counterpartyAddress: doc.counterparty_wallet_address || null,
            creatorSignature: creatorSig,
            counterpartySignature: counterpartySig,
            note: doc.note,
        });

        // Store the job ID so we can poll for status
        await db.execute(
            `UPDATE notary_documents SET chain_status = 'embedding', chain_job_id = ? WHERE doc_uuid = ?`,
            [embedResult.jobId, docUuid]
        );

        await audit.log(docUuid, doc.creator_wallet_address, 'chain_embed_started', {
            jobId: embedResult.jobId,
            estimatedChunks: embedResult.estimatedChunks,
            estimatedCostKas: embedResult.estimatedCostKas,
        });

        console.log(`[Notary] Chain embed started for ${docUuid}, job: ${embedResult.jobId}`);

    } catch (err) {
        console.error(`[Notary] Chain embed trigger failed for ${docUuid}:`, err.message);
        await db.execute(
            `UPDATE notary_documents SET chain_status = 'failed' WHERE doc_uuid = ?`,
            [docUuid]
        ).catch(() => {});
        await audit.log(docUuid, doc.creator_wallet_address, 'chain_embed_failed', { error: err.message });
    }
}

// Multer: store uploads in memory, max 10MB, PDF only
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are accepted'));
        }
    }
});

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

/**
 * POST /api/auth/connect
 * Wallet-based authentication. Frontend sends wallet address
 * after user connects via KasperoPay widget.
 * Returns a JWT.
 */
router.post('/auth/connect', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || typeof address !== 'string' || !address.startsWith('kaspa:')) {
            return res.status(400).json({ error: 'Valid Kaspa address required' });
        }

        const walletAddress = address.trim();

        // Upsert user
        await db.execute(
            `INSERT INTO notary_users (wallet_address) VALUES (?)
             ON DUPLICATE KEY UPDATE last_seen_at = NOW()`,
            [walletAddress]
        );

        const token = generateToken(walletAddress);
        await audit.log(null, walletAddress, 'auth_connect', null, req.ip);

        // Fetch stored email for pre-fill
        const [userRows] = await db.execute(
            'SELECT email FROM notary_users WHERE wallet_address = ?',
            [walletAddress]
        );
        const userEmail = (userRows.length && userRows[0].email) ? userRows[0].email : null;

        res.json({ success: true, token, address: walletAddress, email: userEmail });
    } catch (err) {
        console.error('Auth error:', err);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

/**
 * GET /api/config
 * Public endpoint - returns fee amount and merchant ID
 */
router.get('/config', (req, res) => {
    res.json({
        fee_kas: NOTARY_FEE_KAS,
        merchant_id: process.env.KASPERO_PAY_MERCHANT_ID || null
    });
});

// ─────────────────────────────────────────────
// PUBLIC ARCHIVE (with search + filter)
// ─────────────────────────────────────────────

/**
 * GET /api/archive
 * Public endpoint - returns notarized documents for the public archive.
 * Supports search, category filter, date filter, and pagination.
 *
 * Query params:
 *   q         - search term (matches public title, hash, wallet addresses)
 *   category  - filter by category enum value
 *   period    - 'week', 'month', '3months', 'year', 'all' (default: 'all')
 *   page      - page number (default: 1)
 *   limit     - results per page (default: 20, max: 50)
 */
router.get('/archive', async (req, res) => {
    try {
        const { q, category, period, page, limit } = req.query;

        const pageNum = Math.max(1, parseInt(page) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * pageSize;

        let where = [`status = 'notarized'`];
        let params = [];

        // Search filter
        if (q && q.trim()) {
            const search = q.trim();
            where.push(`(
                (title_public = 1 AND title LIKE ?) OR
                original_hash LIKE ? OR
                creator_wallet_address LIKE ? OR
                counterparty_wallet_address LIKE ? OR
                seal_tx_id LIKE ?
            )`);
            const like = `%${search}%`;
            params.push(like, like, like, like, like);
        }

        // Category filter
        if (category && category !== 'all') {
            where.push('category = ?');
            params.push(category);
        }

        // Date filter
        if (period && period !== 'all') {
            const intervals = { week: 7, month: 30, '3months': 90, year: 365 };
            const days = intervals[period];
            if (days) {
                where.push('notarized_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
                params.push(days);
            }
        }

        const whereClause = where.join(' AND ');

        // Get total count
        const [countRows] = await db.execute(
            `SELECT COUNT(*) as total FROM notary_documents WHERE ${whereClause}`,
            params
        );
        const total = countRows[0].total;

        // Get documents (LIMIT/OFFSET interpolated directly - values are already parseInt-validated above)
        const [rows] = await db.execute(
            `SELECT doc_uuid, title, title_public, is_public, category, original_hash, file_size,
                    creator_wallet_address, counterparty_wallet_address,
                    seal_tx_id, chain_status, manifest_tx_id, notarized_at
             FROM notary_documents 
             WHERE ${whereClause}
             ORDER BY notarized_at DESC
             LIMIT ${pageSize} OFFSET ${offset}`,
            params
        );

        const documents = rows.map(doc => ({
            doc_uuid: doc.doc_uuid,
            title: doc.title_public ? doc.title : null,
            is_public: !!doc.is_public,
            category: doc.category || 'contract',
            original_hash: doc.original_hash,
            file_size: doc.file_size,
            party_a: doc.creator_wallet_address,
            party_b: doc.counterparty_wallet_address,
            seal_tx_id: doc.seal_tx_id,
            chain_status: doc.chain_status || 'none',
            manifest_tx_id: doc.manifest_tx_id || null,
            notarized_at: doc.notarized_at
        }));

        res.json({
            success: true,
            documents,
            pagination: {
                page: pageNum,
                limit: pageSize,
                total,
                pages: Math.ceil(total / pageSize)
            }
        });
    } catch (err) {
        console.error('Archive error:', err);
        res.status(500).json({ error: 'Failed to load archive' });
    }
});

/**
 * GET /api/archive/:docUuid/pdf
 * Download PDF for public documents only. No auth required.
 */
router.get('/archive/:docUuid/pdf', async (req, res) => {
    try {
        const { docUuid } = req.params;
        const [rows] = await db.execute(
            'SELECT original_file_path, title, is_public, status FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        if (!rows[0].is_public || rows[0].status !== 'notarized') {
            return res.status(403).json({ error: 'Document is not publicly available' });
        }

        const pdfBuffer = await notaryService.getOriginalPdf(rows[0].original_file_path);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${rows[0].title}.pdf"`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('Archive PDF error:', err);
        res.status(500).json({ error: 'Failed to load PDF' });
    }
});

// ─────────────────────────────────────────────
// CREATE DOCUMENT
// ─────────────────────────────────────────────

/**
 * POST /api/documents
 * Upload PDF, set title, optional counterparty email. Creates draft.
 * If no counterparty_email, this is a single-signer document.
 */
router.post('/documents', requireAuth, upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'PDF file required' });
        }

        const { title, counterparty_email, creator_email, note, category, is_public, title_public, upload_to_chain } = req.body;
        if (!title) {
            return res.status(400).json({ error: 'Title required' });
        }

        // Counterparty email is optional - if absent, single-signer mode
        if (counterparty_email && !counterparty_email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required for counterparty' });
        }

        const validCategories = ['contract', 'agreement', 'patent', 'nda', 'certificate', 'other'];
        const docCategory = validCategories.includes(category) ? category : 'contract';

        const docUuid = uuidv4();
        const { filePath, hash, fileSize } = await notaryService.storeDocument(
            req.file.buffer, docUuid, req.file.originalname
        );

        const docIsPublic = is_public === 'true' || is_public === true ? 1 : 0;
        const docTitlePublic = title_public === 'false' || title_public === false ? 0 : 1;
        const docUploadToChain = upload_to_chain === 'true' || upload_to_chain === true ? 1 : 0;

        await db.execute(
            `INSERT INTO notary_documents 
             (doc_uuid, creator_wallet_address, creator_email, counterparty_email, title, note, category, original_file_path, original_hash, file_size, is_public, title_public, upload_to_chain, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
            [docUuid, req.walletAddress, (creator_email || '').trim() || null, counterparty_email ? counterparty_email.trim() : null, title.trim(), note || null, docCategory, filePath, hash, fileSize, docIsPublic, docTitlePublic, docUploadToChain]
        );

        // Also update the user's email in the users table
        if (creator_email && creator_email.includes('@')) {
            await db.execute(
                'UPDATE notary_users SET email = ? WHERE wallet_address = ?',
                [creator_email.trim(), req.walletAddress]
            ).catch(() => {});
        }

        await audit.log(docUuid, req.walletAddress, 'document_created', { title, counterparty_email: counterparty_email || null, category: docCategory }, req.ip);

        res.json({
            success: true,
            doc_uuid: docUuid,
            hash: hash,
            original_hash: hash,
            file_size: fileSize,
            fee_kas: NOTARY_FEE_KAS,
            single_signer: !counterparty_email
        });
    } catch (err) {
        console.error('Create document error:', err);
        res.status(500).json({ error: 'Failed to create document' });
    }
});

// ─────────────────────────────────────────────
// UPDATE DRAFT
// ─────────────────────────────────────────────

/**
 * PUT /api/documents/:docUuid
 * Edit a draft document - title, counterparty email, note, category, visibility, or replace PDF.
 */
router.put('/documents/:docUuid', requireAuth, upload.single('pdf'), async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT * FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.creator_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Only the creator can edit' });
        }
        if (doc.status !== 'draft') {
            return res.status(400).json({ error: 'Only draft documents can be edited' });
        }

        const updates = [];
        const params = [];

        if (req.body.title && req.body.title.trim()) {
            updates.push('title = ?');
            params.push(req.body.title.trim());
        }
        if (req.body.counterparty_email !== undefined) {
            updates.push('counterparty_email = ?');
            // Allow clearing counterparty (switching to single-signer)
            params.push(req.body.counterparty_email && req.body.counterparty_email.includes('@') ? req.body.counterparty_email.trim() : null);
        }
        if (req.body.note !== undefined) {
            updates.push('note = ?');
            params.push(req.body.note || null);
        }
        if (req.body.category !== undefined) {
            const validCategories = ['contract', 'agreement', 'patent', 'nda', 'certificate', 'other'];
            if (validCategories.includes(req.body.category)) {
                updates.push('category = ?');
                params.push(req.body.category);
            }
        }
        if (req.body.is_public !== undefined) {
            updates.push('is_public = ?');
            params.push(req.body.is_public === 'true' || req.body.is_public === true ? 1 : 0);
        }
        if (req.body.title_public !== undefined) {
            updates.push('title_public = ?');
            params.push(req.body.title_public === 'false' || req.body.title_public === false ? 0 : 1);
        }
        if (req.body.upload_to_chain !== undefined) {
            updates.push('upload_to_chain = ?');
            params.push(req.body.upload_to_chain === 'true' || req.body.upload_to_chain === true ? 1 : 0);
        }

        // Replace PDF if a new one was uploaded
        if (req.file) {
            const { filePath, hash, fileSize } = await notaryService.storeDocument(
                req.file.buffer, docUuid, req.file.originalname
            );
            updates.push('original_file_path = ?, original_hash = ?, file_size = ?');
            params.push(filePath, hash, fileSize);
        }

        if (!updates.length) {
            return res.status(400).json({ error: 'Nothing to update' });
        }

        params.push(docUuid);
        await db.execute(
            `UPDATE notary_documents SET ${updates.join(', ')} WHERE doc_uuid = ?`,
            params
        );

        await audit.log(docUuid, req.walletAddress, 'draft_updated', { fields: updates.length }, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('Update draft error:', err);
        res.status(500).json({ error: 'Failed to update document' });
    }
});

/**
 * DELETE /api/documents/:docUuid
 * Delete a draft document. Only creator, only drafts.
 */
router.delete('/documents/:docUuid', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT creator_wallet_address, status, original_file_path FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.creator_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Only the creator can delete' });
        }
        if (doc.status !== 'draft') {
            return res.status(400).json({ error: 'Only draft documents can be deleted' });
        }

        // Delete the PDF file
        try {
            const fs = require('fs').promises;
            await fs.unlink(doc.original_file_path);
        } catch (fsErr) {
            console.error('File delete error:', fsErr.message);
        }

        await db.execute('DELETE FROM notary_documents WHERE doc_uuid = ?', [docUuid]);
        await audit.log(docUuid, req.walletAddress, 'draft_deleted', null, req.ip);

        res.json({ success: true });
    } catch (err) {
        console.error('Delete draft error:', err);
        res.status(500).json({ error: 'Failed to delete document' });
    }
});

// ─────────────────────────────────────────────
// SIGNATURE FIELDS
// ─────────────────────────────────────────────

/**
 * PUT /api/documents/:docUuid/fields
 * Set signature field positions on the PDF
 */
router.put('/documents/:docUuid/fields', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;
        const { fields } = req.body;

        const [rows] = await db.execute(
            'SELECT id, creator_wallet_address, status FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        if (rows[0].creator_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Only the creator can set signature fields' });
        }
        if (rows[0].status !== 'draft' && rows[0].status !== 'paid') {
            return res.status(400).json({ error: 'Cannot modify fields after signing has begun' });
        }

        if (!Array.isArray(fields) || fields.length === 0) {
            return res.status(400).json({ error: 'At least one signature field required' });
        }

        // Validate field structure
        for (const f of fields) {
            if (!['A', 'B'].includes(f.party) || !f.page || !f.x || !f.y || !f.width || !f.height) {
                return res.status(400).json({ error: 'Invalid signature field format' });
            }
        }

        await db.execute(
            'UPDATE notary_documents SET signature_fields = ? WHERE doc_uuid = ?',
            [JSON.stringify(fields), docUuid]
        );

        await audit.log(docUuid, req.walletAddress, 'fields_set', { count: fields.length }, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('Set fields error:', err);
        res.status(500).json({ error: 'Failed to set signature fields' });
    }
});

// ─────────────────────────────────────────────
// PAYMENT CONFIRMATION
// ─────────────────────────────────────────────

/**
 * POST /api/documents/:docUuid/payment
 * Record that Party A has paid the notary fee via KasperoPay.
 * Frontend submits the payment TX ID after widget confirms.
 */
router.post('/documents/:docUuid/payment', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;
        const { tx_id, payment_id, amount_kas } = req.body;

        if (!tx_id) return res.status(400).json({ error: 'Payment transaction ID required' });

        const [rows] = await db.execute(
            'SELECT id, creator_wallet_address, status FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        if (rows[0].creator_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Only the creator can submit payment' });
        }
        if (rows[0].status !== 'draft') {
            return res.status(400).json({ error: 'Payment already recorded' });
        }

        // Server-side verification against KasperoPay API
        if (payment_id) {
            try {
                const verifyRes = await fetch(`https://kaspa-store.com/pay/status/${payment_id}`);
                const verifyData = await verifyRes.json();
                if (verifyData.status !== 'completed') {
                    return res.status(400).json({ error: 'Payment not confirmed by KasperoPay' });
                }
                if (verifyData.amount_kas < NOTARY_FEE_KAS * 0.99) {
                    return res.status(400).json({ error: 'Insufficient payment amount' });
                }
            } catch (verifyErr) {
                console.error('KasperoPay verification error:', verifyErr.message);
                // Continue anyway - TX ID is on-chain and verifiable
            }
        }

        await db.execute(
            `UPDATE notary_documents 
             SET payment_tx_id = ?, payment_amount_kas = ?, payment_confirmed_at = NOW(), status = 'paid'
             WHERE doc_uuid = ?`,
            [tx_id, amount_kas || NOTARY_FEE_KAS, docUuid]
        );

        await audit.log(docUuid, req.walletAddress, 'payment_confirmed', { tx_id, payment_id, amount_kas }, req.ip);
        res.json({ success: true, status: 'paid' });
    } catch (err) {
        console.error('Payment error:', err);
        res.status(500).json({ error: 'Failed to record payment' });
    }
});

// ─────────────────────────────────────────────
// SIGN DOCUMENT
// ─────────────────────────────────────────────

/**
 * POST /api/documents/:docUuid/sign
 * Party A or Party B signs the document.
 * Accepts two signature types:
 *   - type: 'schnorr' - cryptographic Schnorr sig from wallet extension
 *   - type: 'typed' - fallback typed name (when wallet doesn't support signMessage)
 *
 * Two-party: When Party B signs, auto-seals on blockchain.
 * Single-signer: When Party A signs, auto-seals immediately (no counterparty needed).
 */
router.post('/documents/:docUuid/sign', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;
        const { signature, agreed, email } = req.body;

        if (!signature || !signature.type) {
            return res.status(400).json({ error: 'Signature data required' });
        }
        // Validate based on type
        if (signature.type === 'schnorr') {
            if (!signature.schnorr_signature) {
                return res.status(400).json({ error: 'Schnorr signature required' });
            }
        } else if (signature.type === 'typed') {
            if (!signature.value) {
                return res.status(400).json({ error: 'Typed name required' });
            }
        } else {
            return res.status(400).json({ error: 'Unknown signature type' });
        }
        if (!agreed) {
            return res.status(400).json({ error: 'You must confirm you have read and agree to the document' });
        }

        const [rows] = await db.execute(
            'SELECT * FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        const isCreator = doc.creator_wallet_address === req.walletAddress;
        const isSingleSigner = !doc.counterparty_email;

        // Determine which party is signing
        let party;
        if (isCreator && !doc.creator_signature) {
            party = 'A';
        } else if (!isCreator && !doc.counterparty_signature) {
            party = 'B';
        } else {
            return res.status(400).json({ error: 'You have already signed or are not authorized' });
        }

        // Status checks
        if (party === 'A' && doc.status !== 'paid') {
            return res.status(400).json({ error: 'Payment required before signing' });
        }
        if (party === 'B' && doc.status !== 'pending_cosign') {
            return res.status(400).json({ error: 'Document is not ready for countersigning' });
        }

        const sigData = {
            type: signature.type,
            agreed: true,
            timestamp: new Date().toISOString(),
            wallet_address: req.walletAddress,
            wallet_provider: signature.wallet_provider || null
        };

        if (signature.type === 'schnorr') {
            sigData.schnorr_signature = signature.schnorr_signature;
            sigData.public_key = signature.public_key || null;
            sigData.signed_message = signature.signed_message || null;
            sigData.sign_timestamp = signature.sign_timestamp || null;
            sigData.typed_name = signature.typed_name || null;
        } else {
            // Typed fallback
            sigData.value = signature.value;
            sigData.crypto_unavailable = signature.crypto_unavailable || false;
        }

        if (party === 'A') {
            // ── SINGLE-SIGNER: sign + auto-seal ──
            if (isSingleSigner) {
                await db.execute(
                    `UPDATE notary_documents 
                     SET creator_signature = ?, creator_signed_at = NOW(), status = 'pending_finalization'
                     WHERE doc_uuid = ?`,
                    [JSON.stringify(sigData), docUuid]
                );

                await audit.log(docUuid, req.walletAddress, 'creator_signed', { single_signer: true }, req.ip);

                // Auto-seal: no counterparty needed
                let sealResult = null;
                try {
                    sealResult = await keystoneService.sendSealTx(
                        doc.creator_wallet_address,
                        null, // No Party B
                        doc.original_hash
                    );

                    await db.execute(
                        `UPDATE notary_documents 
                         SET seal_tx_id = ?, seal_payload = ?, status = 'notarized', notarized_at = NOW()
                         WHERE doc_uuid = ?`,
                        [sealResult.txId, sealResult.payload, docUuid]
                    );

                    await audit.log(docUuid, req.walletAddress, 'document_notarized', { seal_tx_id: sealResult.txId, single_signer: true }, req.ip);

                    // Send confirmation email to creator
                    if (doc.creator_email) {
                        const proofUrl = `${APP_URL}/proof/${docUuid}`;
                        emailService.sendNotarizedEmail(doc.creator_email, {
                            title: doc.title,
                            proofUrl,
                            sealTxId: sealResult.txId,
                            documentHash: doc.original_hash,
                            partyAWallet: doc.creator_wallet_address,
                            partyBWallet: null,
                            notarizedAt: new Date().toISOString(),
                            explorerUrl: 'https://explorer.kaspa.org/txs/'
                        }).catch(() => {});
                    }

                    // Fire-and-forget: embed file on chain if requested
                    triggerChainEmbed(docUuid, doc).catch(() => {});

                    return res.json({ success: true, party: 'A', status: 'notarized', seal_tx_id: sealResult.txId, single_signer: true, upload_to_chain: !!doc.upload_to_chain });

                } catch (sealErr) {
                    console.error('Single-signer auto-seal error:', sealErr.message);
                    return res.json({
                        success: true,
                        party: 'A',
                        status: 'pending_finalization',
                        single_signer: true,
                        seal_error: 'Blockchain seal pending - will retry automatically'
                    });
                }
            }

            // ── TWO-PARTY: creator signs, wait for counterparty ──
            await db.execute(
                `UPDATE notary_documents 
                 SET creator_signature = ?, creator_signed_at = NOW(), status = 'pending_cosign'
                 WHERE doc_uuid = ?`,
                [JSON.stringify(sigData), docUuid]
            );

            // Generate invite token
            const inviteToken = notaryService.generateInviteToken();
            const inviteUrl = `${APP_URL}/invite/${inviteToken}`;
            await db.execute(
                'UPDATE notary_documents SET invite_token = ? WHERE doc_uuid = ?',
                [inviteToken, docUuid]
            );

            // Send email invite unless Party A chose link-only
            const skipEmail = req.body.skip_invite_email === true;
            if (!skipEmail && doc.counterparty_email) {
                emailService.sendInviteEmail(doc.counterparty_email, {
                    title: doc.title,
                    creatorAddress: doc.creator_wallet_address,
                    note: doc.note,
                    inviteUrl
                }).catch(err => console.error('Invite email error:', err.message));
                await db.execute(
                    'UPDATE notary_documents SET invite_sent_at = NOW() WHERE doc_uuid = ?',
                    [docUuid]
                );
                await audit.log(docUuid, req.walletAddress, 'invite_auto_sent', { to: doc.counterparty_email }, req.ip);
            }

            await audit.log(docUuid, req.walletAddress, 'creator_signed', null, req.ip);

            res.json({ success: true, party: 'A', status: 'pending_cosign', invite_url: inviteUrl });

        } else {
            // ── Party B signs - auto-seal ──
            const updateFields = [JSON.stringify(sigData), req.walletAddress];
            let emailUpdate = '';
            if (email && email.includes('@') && !doc.counterparty_email) {
                emailUpdate = ', counterparty_email = ?';
                updateFields.push(email.trim());
            } else if (email && email.includes('@') && doc.counterparty_email !== email.trim()) {
                emailUpdate = ', counterparty_email = ?';
                updateFields.push(email.trim());
            }
            updateFields.push(docUuid);

            await db.execute(
                `UPDATE notary_documents 
                 SET counterparty_signature = ?, counterparty_wallet_address = ?, counterparty_signed_at = NOW(), status = 'pending_finalization'${emailUpdate}
                 WHERE doc_uuid = ?`,
                updateFields
            );

            await audit.log(docUuid, req.walletAddress, 'counterparty_signed', null, req.ip);

            // Auto-seal: both parties have signed, send the blockchain TX
            let sealResult = null;
            try {
                sealResult = await keystoneService.sendSealTx(
                    doc.creator_wallet_address,
                    req.walletAddress,
                    doc.original_hash
                );

                await db.execute(
                    `UPDATE notary_documents 
                     SET seal_tx_id = ?, seal_payload = ?, status = 'notarized', notarized_at = NOW()
                     WHERE doc_uuid = ?`,
                    [sealResult.txId, sealResult.payload, docUuid]
                );

                await audit.log(docUuid, req.walletAddress, 'document_notarized', { seal_tx_id: sealResult.txId }, req.ip);

                // Send confirmation emails to both parties (non-blocking)
                const proofUrl = `${APP_URL}/proof/${docUuid}`;
                const explorerUrl = 'https://explorer.kaspa.org/txs/';
                const emailData = {
                    title: doc.title,
                    proofUrl,
                    sealTxId: sealResult.txId,
                    documentHash: doc.original_hash,
                    partyAWallet: doc.creator_wallet_address,
                    partyBWallet: req.walletAddress,
                    notarizedAt: new Date().toISOString(),
                    explorerUrl
                };
                if (doc.creator_email) {
                    emailService.sendNotarizedEmail(doc.creator_email, emailData).catch(() => {});
                }
                const partyBEmail = (email && email.includes('@')) ? email.trim() : doc.counterparty_email;
                if (partyBEmail) {
                    emailService.sendNotarizedEmail(partyBEmail, emailData).catch(() => {});
                }

                // Fire-and-forget: embed file on chain if requested
                triggerChainEmbed(docUuid, doc).catch(() => {});

                res.json({ success: true, party: 'B', status: 'notarized', seal_tx_id: sealResult.txId, upload_to_chain: !!doc.upload_to_chain });

            } catch (sealErr) {
                console.error('Auto-seal error:', sealErr.message);
                res.json({
                    success: true,
                    party: 'B',
                    status: 'pending_finalization',
                    seal_error: 'Blockchain seal pending - will retry automatically'
                });
            }
        }
    } catch (err) {
        console.error('Sign error:', err);
        res.status(500).json({ error: 'Failed to sign document' });
    }
});

// ─────────────────────────────────────────────
// INVITE COUNTERPARTY
// ─────────────────────────────────────────────

/**
 * POST /api/documents/:docUuid/invite
 * Send email invitation to counterparty
 */
router.post('/documents/:docUuid/invite', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT * FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.creator_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Only the creator can send invitations' });
        }

        if (!doc.counterparty_email) {
            return res.status(400).json({ error: 'No counterparty on this document - single-signer mode' });
        }

        if (doc.status !== 'pending_cosign') {
            return res.status(400).json({ error: 'Creator must sign before inviting counterparty' });
        }

        // Generate invite token
        const inviteToken = notaryService.generateInviteToken();
        const inviteUrl = `${APP_URL}/invite/${inviteToken}`;

        await db.execute(
            'UPDATE notary_documents SET invite_token = ?, invite_sent_at = NOW() WHERE doc_uuid = ?',
            [inviteToken, docUuid]
        );

        // Send email
        try {
            await emailService.sendInviteEmail(doc.counterparty_email, {
                title: doc.title,
                creatorAddress: doc.creator_wallet_address,
                note: doc.note,
                inviteUrl
            });
        } catch (emailErr) {
            console.error('Email send error:', emailErr.message);
        }

        await audit.log(docUuid, req.walletAddress, 'invite_sent', { to: doc.counterparty_email }, req.ip);

        res.json({ success: true, invite_url: inviteUrl });
    } catch (err) {
        console.error('Invite error:', err);
        res.status(500).json({ error: 'Failed to send invitation' });
    }
});

// ─────────────────────────────────────────────
// INVITE LOOKUP (public - counterparty lands here)
// ─────────────────────────────────────────────

/**
 * GET /api/invite/:token
 * Counterparty uses this to load the document for signing.
 * No auth required - the invite token IS the auth for viewing.
 */
router.get('/invite/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const [rows] = await db.execute(
            `SELECT doc_uuid, title, note, original_hash, file_size, status, category,
                    is_public, title_public,
                    creator_wallet_address, creator_email, counterparty_wallet_address, counterparty_email,
                    creator_signature, counterparty_signature,
                    seal_tx_id, seal_payload,
                    payment_tx_id, payment_amount_kas,
                    created_at, creator_signed_at, counterparty_signed_at, notarized_at, invite_sent_at
             FROM notary_documents WHERE invite_token = ?`,
            [token]
        );

        if (!rows.length) return res.status(404).json({ error: 'Invalid or expired invite link' });
        const doc = rows[0];

        if (doc.status === 'cancelled' || doc.status === 'expired') {
            return res.status(410).json({ error: 'This document has been ' + doc.status });
        }

        await audit.log(doc.doc_uuid, null, 'invite_viewed', null, req.ip);

        res.json({
            success: true,
            document: {
                doc_uuid: doc.doc_uuid,
                title: doc.title,
                note: doc.note,
                status: doc.status,
                category: doc.category,
                original_hash: doc.original_hash,
                file_size: doc.file_size,
                is_public: !!doc.is_public,
                title_public: !!doc.title_public,
                creator_wallet_address: doc.creator_wallet_address,
                creator_email: doc.creator_email || null,
                counterparty_email: doc.counterparty_email,
                counterparty_wallet_address: doc.counterparty_wallet_address,
                creator_signature: doc.creator_signature || null,
                counterparty_signature: doc.counterparty_signature || null,
                seal_tx_id: doc.seal_tx_id,
                seal_payload: doc.seal_payload,
                payment_tx_id: doc.payment_tx_id,
                payment_amount_kas: doc.payment_amount_kas,
                created_at: doc.created_at,
                creator_signed_at: doc.creator_signed_at,
                counterparty_signed_at: doc.counterparty_signed_at,
                notarized_at: doc.notarized_at,
                invite_sent_at: doc.invite_sent_at
            }
        });
    } catch (err) {
        console.error('Invite lookup error:', err);
        res.status(500).json({ error: 'Failed to load document' });
    }
});

/**
 * GET /api/invite/:token/pdf
 * Download the original PDF via invite token (for counterparty viewing)
 */
router.get('/invite/:token/pdf', async (req, res) => {
    try {
        const { token } = req.params;

        const [rows] = await db.execute(
            'SELECT original_file_path, title FROM notary_documents WHERE invite_token = ?',
            [token]
        );

        if (!rows.length) return res.status(404).json({ error: 'Invalid invite' });

        const pdfBuffer = await notaryService.getOriginalPdf(rows[0].original_file_path);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${rows[0].title}.pdf"`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('Invite PDF error:', err);
        res.status(500).json({ error: 'Failed to load document' });
    }
});

// ─────────────────────────────────────────────
// VIEW DOCUMENT
// ─────────────────────────────────────────────

/**
 * GET /api/documents/:docUuid
 * Get document details. Only creator or counterparty.
 */
router.get('/documents/:docUuid', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT * FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        // Access control
        if (doc.creator_wallet_address !== req.walletAddress && doc.counterparty_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await audit.log(docUuid, req.walletAddress, 'document_viewed', null, req.ip);

        res.json({
            success: true,
            document: {
                doc_uuid: doc.doc_uuid,
                title: doc.title,
                note: doc.note,
                status: doc.status,
                category: doc.category,
                original_hash: doc.original_hash,
                file_size: doc.file_size,
                is_public: !!doc.is_public,
                title_public: !!doc.title_public,
                creator_wallet_address: doc.creator_wallet_address,
                creator_email: doc.creator_email || null,
                counterparty_email: doc.counterparty_email || null,
                counterparty_wallet_address: doc.counterparty_wallet_address,
                creator_signature: doc.creator_signature || null,
                counterparty_signature: doc.counterparty_signature || null,
                seal_tx_id: doc.seal_tx_id,
                seal_payload: doc.seal_payload,
                payment_tx_id: doc.payment_tx_id,
                payment_amount_kas: doc.payment_amount_kas,
                upload_to_chain: !!doc.upload_to_chain,
                chain_status: doc.chain_status || 'none',
                manifest_tx_id: doc.manifest_tx_id || null,
                chunk_count: doc.chunk_count || null,
                chain_embed_cost_kas: doc.chain_embed_cost_kas ? parseFloat(doc.chain_embed_cost_kas) : null,
                created_at: doc.created_at,
                creator_signed_at: doc.creator_signed_at,
                counterparty_signed_at: doc.counterparty_signed_at,
                notarized_at: doc.notarized_at,
                invite_sent_at: doc.invite_sent_at
            }
        });
    } catch (err) {
        console.error('View document error:', err);
        res.status(500).json({ error: 'Failed to load document' });
    }
});

/**
 * GET /api/documents/:docUuid/pdf
 * Download original PDF (authenticated)
 */
router.get('/documents/:docUuid/pdf', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT original_file_path, title, creator_wallet_address, counterparty_wallet_address FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.creator_wallet_address !== req.walletAddress && doc.counterparty_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const pdfBuffer = await notaryService.getOriginalPdf(doc.original_file_path);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${doc.title}.pdf"`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('PDF download error:', err);
        res.status(500).json({ error: 'Failed to load PDF' });
    }
});

// ─────────────────────────────────────────────
// FINALIZE (retry for failed auto-seal)
// ─────────────────────────────────────────────

/**
 * POST /api/documents/:docUuid/finalize
 * Creator finalizes: send seal TX with structured payload.
 * Used when auto-seal failed and doc is stuck at pending_finalization.
 * Handles both single-signer and two-party documents.
 */
router.post('/documents/:docUuid/finalize', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT * FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.creator_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Only the creator can finalize' });
        }
        if (doc.status !== 'pending_finalization') {
            return res.status(400).json({ error: 'Document is not ready for finalization' });
        }

        // Send seal transaction with structured payload
        let sealTx;
        try {
            sealTx = await keystoneService.sendSealTx(
                doc.creator_wallet_address,
                doc.counterparty_wallet_address || null, // null for single-signer
                doc.original_hash
            );
        } catch (txErr) {
            console.error('Seal TX error:', txErr.message);
            return res.status(503).json({ error: 'Seal transaction failed: ' + txErr.message });
        }

        // Update database
        await db.execute(
            `UPDATE notary_documents 
             SET seal_tx_id = ?, seal_payload = ?, status = 'notarized', notarized_at = NOW()
             WHERE doc_uuid = ?`,
            [sealTx.txId, sealTx.payload, docUuid]
        );

        await audit.log(docUuid, req.walletAddress, 'document_notarized', { seal_tx_id: sealTx.txId, payload: sealTx.payload }, req.ip);

        // Send notification emails (non-blocking)
        const proofUrl = `${APP_URL}/proof/${docUuid}`;
        const emailData = {
            title: doc.title,
            proofUrl,
            sealTxId: sealTx.txId,
            documentHash: doc.original_hash,
            partyAWallet: doc.creator_wallet_address,
            partyBWallet: doc.counterparty_wallet_address || null,
            notarizedAt: new Date().toISOString(),
            explorerUrl: 'https://explorer.kaspa.org/txs/'
        };
        if (doc.creator_email) {
            emailService.sendNotarizedEmail(doc.creator_email, emailData).catch(() => {});
        }
        if (doc.counterparty_email) {
            emailService.sendNotarizedEmail(doc.counterparty_email, emailData).catch(() => {});
        }

        // Fire-and-forget: embed file on chain if requested
        triggerChainEmbed(docUuid, doc).catch(() => {});

        res.json({
            success: true,
            status: 'notarized',
            seal_tx_id: sealTx.txId,
            payload: sealTx.payload,
            upload_to_chain: !!doc.upload_to_chain
        });
    } catch (err) {
        console.error('Finalize error:', err);
        res.status(500).json({ error: 'Failed to finalize document' });
    }
});

// ─────────────────────────────────────────────
// DOWNLOAD PDF
// ─────────────────────────────────────────────

/**
 * GET /api/documents/:docUuid/download
 * Download the original PDF. Auth required, parties only.
 */
router.get('/documents/:docUuid/download', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT original_file_path, title, status, creator_wallet_address, counterparty_wallet_address FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.creator_wallet_address !== req.walletAddress && doc.counterparty_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Access denied' });
        }
        if (doc.status !== 'notarized') {
            return res.status(400).json({ error: 'Document not yet finalized' });
        }

        const fs = require('fs').promises;
        const pdfBuffer = await fs.readFile(doc.original_file_path);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.title} - Notarized.pdf"`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Failed to download document' });
    }
});

// ─────────────────────────────────────────────
// PROOF (public)
// ─────────────────────────────────────────────

/**
 * GET /api/proof/:docUuid
 * Public proof endpoint - returns on-chain verifiable data.
 * Also returns visibility flags so frontend can conditionally show title/PDF.
 */
router.get('/proof/:docUuid', async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            `SELECT doc_uuid, title, title_public, is_public, category, status, original_hash,
                    creator_wallet_address, counterparty_wallet_address,
                    seal_tx_id, seal_payload, manifest_tx_id, chunk_count,
                    upload_to_chain, chain_status,
                    creator_signed_at, counterparty_signed_at, notarized_at
             FROM notary_documents WHERE doc_uuid = ?`,
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.status !== 'notarized') {
            return res.status(400).json({ error: 'Document not yet notarized' });
        }

        res.json({
            success: true,
            proof: {
                doc_uuid: doc.doc_uuid,
                title: doc.title_public ? doc.title : null,
                title_public: !!doc.title_public,
                is_public: !!doc.is_public,
                category: doc.category || 'contract',
                document_hash: doc.original_hash,
                party_a: doc.creator_wallet_address,
                party_b: doc.counterparty_wallet_address || null,
                seal_tx_id: doc.seal_tx_id,
                seal_payload: doc.seal_payload,
                manifest_tx_id: doc.manifest_tx_id || null,
                chunk_count: doc.chunk_count || null,
                upload_to_chain: !!doc.upload_to_chain,
                chain_status: doc.chain_status || 'none',
                party_a_signed: doc.creator_signed_at,
                party_b_signed: doc.counterparty_signed_at,
                notarized_at: doc.notarized_at
            }
        });
    } catch (err) {
        console.error('Proof error:', err);
        res.status(500).json({ error: 'Failed to load proof' });
    }
});

// ─────────────────────────────────────────────
// CHAIN EMBED STATUS (polling endpoint)
// ─────────────────────────────────────────────

/**
 * GET /api/documents/:docUuid/chain-status
 * Poll the status of on-chain file embedding.
 * Called by frontend spinner while embedding is in progress.
 * 
 * If chain_status is 'embedding' and we have a job ID, we check
 * Keystone for updated progress. If Keystone reports confirmed,
 * we update our DB and return the final result.
 */
router.get('/documents/:docUuid/chain-status', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            `SELECT doc_uuid, chain_status, chain_job_id, manifest_tx_id, chunk_tx_ids, chunk_count,
                    chain_embed_cost_kas, upload_to_chain, creator_wallet_address, counterparty_wallet_address
             FROM notary_documents WHERE doc_uuid = ?`,
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        // Access control
        if (doc.creator_wallet_address !== req.walletAddress && doc.counterparty_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!doc.upload_to_chain) {
            return res.json({ success: true, chain_status: 'none', upload_to_chain: false });
        }

        // If still in progress and we have a job ID, poll Keystone
        if ((doc.chain_status === 'embedding' || doc.chain_status === 'pending') && doc.chain_job_id) {
            try {
                const status = await keystoneService.checkEmbedStatus(doc.chain_job_id);

                if (status.status === 'confirmed') {
                    // Embedding complete - update our DB
                    await db.execute(
                        `UPDATE notary_documents 
                         SET chain_status = 'confirmed', manifest_tx_id = ?, chunk_tx_ids = ?, 
                             chunk_count = ?, chain_embed_cost_kas = ?
                         WHERE doc_uuid = ?`,
                        [
                            status.manifestTxId,
                            JSON.stringify(status.chunkTxIds),
                            status.chunkTxIds ? status.chunkTxIds.length : null,
                            status.actualCostKas,
                            docUuid
                        ]
                    );
                    await audit.log(docUuid, req.walletAddress, 'chain_embed_confirmed', {
                        manifestTxId: status.manifestTxId,
                        chunkCount: status.chunkTxIds ? status.chunkTxIds.length : 0,
                    });

                    return res.json({
                        success: true,
                        chain_status: 'confirmed',
                        manifest_tx_id: status.manifestTxId,
                        chunk_count: status.chunkTxIds ? status.chunkTxIds.length : 0,
                        chunks_completed: status.chunksTotal,
                        chunks_total: status.chunksTotal,
                    });
                }

                if (status.status === 'failed') {
                    await db.execute(
                        `UPDATE notary_documents SET chain_status = 'failed' WHERE doc_uuid = ?`,
                        [docUuid]
                    );
                    await audit.log(docUuid, req.walletAddress, 'chain_embed_failed', { error: status.error });

                    return res.json({
                        success: true,
                        chain_status: 'failed',
                        error: status.error || 'Embedding failed on Keystone',
                    });
                }

                // Still in progress
                return res.json({
                    success: true,
                    chain_status: status.status || 'embedding',
                    chunks_completed: status.chunksCompleted || 0,
                    chunks_total: status.chunksTotal || null,
                });

            } catch (pollErr) {
                console.error(`[Notary] Chain status poll error for ${docUuid}:`, pollErr.message);
                // Return last known state rather than erroring
                return res.json({
                    success: true,
                    chain_status: doc.chain_status,
                    poll_error: 'Could not reach Keystone - will retry',
                });
            }
        }

        // Already confirmed or failed - return stored data
        res.json({
            success: true,
            chain_status: doc.chain_status,
            manifest_tx_id: doc.manifest_tx_id || null,
            chunk_count: doc.chunk_count || null,
            chain_embed_cost_kas: doc.chain_embed_cost_kas ? parseFloat(doc.chain_embed_cost_kas) : null,
        });

    } catch (err) {
        console.error('Chain status error:', err);
        res.status(500).json({ error: 'Failed to check chain status' });
    }
});


// ─────────────────────────────────────────────
// VISIBILITY TOGGLE (retroactive)
// ─────────────────────────────────────────────

/**
 * PATCH /api/documents/:docUuid/visibility
 * Creator can toggle title_public and is_public at any time.
 * Only the original uploader (creator) can change these.
 */
router.patch('/documents/:docUuid/visibility', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            'SELECT creator_wallet_address, title_public, is_public FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        if (!rows.length) return res.status(404).json({ error: 'Document not found' });
        const doc = rows[0];

        if (doc.creator_wallet_address !== req.walletAddress) {
            return res.status(403).json({ error: 'Only the creator can change visibility' });
        }

        const updates = [];
        const params = [];

        if (req.body.title_public !== undefined) {
            updates.push('title_public = ?');
            params.push(req.body.title_public === true || req.body.title_public === 'true' ? 1 : 0);
        }
        if (req.body.is_public !== undefined) {
            updates.push('is_public = ?');
            params.push(req.body.is_public === true || req.body.is_public === 'true' ? 1 : 0);
        }

        if (!updates.length) {
            return res.status(400).json({ error: 'No visibility fields to update' });
        }

        params.push(docUuid);
        await db.execute(
            `UPDATE notary_documents SET ${updates.join(', ')} WHERE doc_uuid = ?`,
            params
        );

        await audit.log(docUuid, req.walletAddress, 'visibility_changed', {
            title_public: req.body.title_public,
            is_public: req.body.is_public,
        }, req.ip);

        // Return the new state
        const [updated] = await db.execute(
            'SELECT title_public, is_public FROM notary_documents WHERE doc_uuid = ?',
            [docUuid]
        );

        res.json({
            success: true,
            title_public: !!updated[0].title_public,
            is_public: !!updated[0].is_public,
        });
    } catch (err) {
        console.error('Visibility update error:', err);
        res.status(500).json({ error: 'Failed to update visibility' });
    }
});

// ─────────────────────────────────────────────
// HASH TOOL (public, no auth)
// ─────────────────────────────────────────────

/**
 * POST /api/hash
 * Public utility - upload a file and get its SHA-256 hash.
 * No file stored, no record created. Pure utility.
 */
router.post('/hash', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'File required' });
        }

        const crypto = require('crypto');
        const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

        res.json({
            success: true,
            hash,
            file_name: req.file.originalname,
            file_size: req.file.size
        });
    } catch (err) {
        console.error('Hash error:', err);
        res.status(500).json({ error: 'Failed to hash file' });
    }
});

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────

/**
 * GET /api/documents
 * List all documents for the authenticated user
 */
router.get('/documents', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT doc_uuid, title, status, category, counterparty_email, counterparty_wallet_address,
                    creator_wallet_address, original_hash, created_at, creator_signed_at, counterparty_signed_at, notarized_at
             FROM notary_documents 
             WHERE creator_wallet_address = ? OR counterparty_wallet_address = ?
             ORDER BY created_at DESC`,
            [req.walletAddress, req.walletAddress]
        );

        const documents = rows.map(doc => ({
            doc_uuid: doc.doc_uuid,
            title: doc.title,
            status: doc.status,
            category: doc.category || 'contract',
            counterparty_email: doc.counterparty_email,
            counterparty_wallet_address: doc.counterparty_wallet_address,
            is_creator: doc.creator_wallet_address === req.walletAddress,
            single_signer: !doc.counterparty_email,
            original_hash: doc.original_hash,
            created_at: doc.created_at,
            creator_signed_at: doc.creator_signed_at,
            counterparty_signed_at: doc.counterparty_signed_at,
            notarized_at: doc.notarized_at
        }));

        res.json({ success: true, documents });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ error: 'Failed to load documents' });
    }
});


// ─────────────────────────────────────────────
// CHAIN EMBED WEBHOOK (Keystone → Notary)
// ─────────────────────────────────────────────

/**
 * POST /api/webhook/chain-complete
 * Called by Keystone when a file embedding job finishes (success or failure).
 * Closes the loop without depending on frontend polling.
 * 
 * Auth: X-Notary-Secret header (same shared secret as Keystone API calls)
 * 
 * Body: { jobId, status, manifestTxId, chunkTxIds, chunkCount, actualCostKas, error }
 */
router.post('/webhook/chain-complete', async (req, res) => {
    try {
        // Authenticate with shared secret (same key Notary uses to call Keystone)
        const secret = req.headers['x-notary-secret'];
        const expectedSecret = process.env.KEYSTONE_API_KEY;
        if (!secret || !expectedSecret || secret !== expectedSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { jobId, status, manifestTxId, chunkTxIds, chunkCount, actualCostKas, error } = req.body;

        if (!jobId || !status) {
            return res.status(400).json({ error: 'jobId and status are required' });
        }

        // Find the document by chain_job_id
        const [docs] = await db.execute(
            'SELECT doc_uuid, chain_status, creator_wallet_address FROM notary_documents WHERE chain_job_id = ?',
            [jobId]
        );

        if (!docs.length) {
            console.warn(`[Webhook] No document found for job ${jobId}`);
            return res.status(404).json({ error: 'No document found for this job ID' });
        }

        const doc = docs[0];

        // Don't overwrite if already confirmed (idempotent)
        if (doc.chain_status === 'confirmed') {
            return res.json({ success: true, message: 'Already confirmed' });
        }

        if (status === 'confirmed' && manifestTxId) {
            await db.execute(
                `UPDATE notary_documents 
                 SET chain_status = 'confirmed', manifest_tx_id = ?, chunk_tx_ids = ?, 
                     chunk_count = ?, chain_embed_cost_kas = ?
                 WHERE chain_job_id = ?`,
                [
                    manifestTxId,
                    chunkTxIds ? JSON.stringify(chunkTxIds) : null,
                    chunkCount || (chunkTxIds ? chunkTxIds.length : null),
                    actualCostKas || null,
                    jobId
                ]
            );

            await audit.log(doc.doc_uuid, 'system', 'chain_embed_confirmed', {
                manifestTxId,
                chunkCount: chunkCount || (chunkTxIds ? chunkTxIds.length : 0),
                source: 'webhook',
            });

            console.log(`[Webhook] Chain embed confirmed for ${doc.doc_uuid} - manifest: ${manifestTxId}`);

        } else if (status === 'failed') {
            await db.execute(
                'UPDATE notary_documents SET chain_status = ? WHERE chain_job_id = ?',
                ['failed', jobId]
            );

            await audit.log(doc.doc_uuid, 'system', 'chain_embed_failed', {
                error: error || 'Unknown error',
                source: 'webhook',
            });

            console.log(`[Webhook] Chain embed failed for ${doc.doc_uuid}: ${error}`);
        }

        res.json({ success: true, docUuid: doc.doc_uuid, chain_status: status });

    } catch (err) {
        console.error('[Webhook] chain-complete error:', err);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});


// ─────────────────────────────────────────────
// RECONSTRUCT FROM BLOCKCHAIN
// ─────────────────────────────────────────────

/**
 * Shared access-control check for reconstruct endpoints.
 * If the manifest belongs to a private doc in our DB, requires wallet auth.
 * Returns true if access is allowed, sends error response and returns false if not.
 */
async function checkReconstructAccess(manifestTxId, req, res) {
    const [docs] = await db.execute(
        `SELECT doc_uuid, is_public, creator_wallet_address, counterparty_wallet_address
         FROM notary_documents WHERE manifest_tx_id = ?`,
        [manifestTxId]
    );

    if (docs.length) {
        const doc = docs[0];
        if (!doc.is_public) {
            const wallet = req.walletAddress;
            if (!wallet) {
                res.status(401).json({ error: 'Connect your wallet to access this private document' });
                return false;
            }
            if (wallet !== doc.creator_wallet_address && wallet !== doc.counterparty_wallet_address) {
                res.status(403).json({ error: 'Only the original signers can access this document' });
                return false;
            }
        }
    }
    return true;
}

/**
 * GET /api/reconstruct/:manifestTxId/stream
 * Server-Sent Events endpoint - streams real-time reconstruction progress.
 * 
 * Note: EventSource doesn't support custom headers, so auth token
 * is accepted as a ?token= query parameter for this endpoint only.
 */
router.get('/reconstruct/:manifestTxId/stream', async (req, res) => {
    try {
        const { manifestTxId } = req.params;
        if (!/^[a-f0-9]{64}$/i.test(manifestTxId)) {
            return res.status(400).json({ error: 'Invalid transaction ID format' });
        }

        // Manual auth from query param (EventSource can't send headers)
        req.walletAddress = null;
        const tokenParam = req.query.token;
        if (tokenParam) {
            try {
                const { verifyToken } = require('../middleware/auth');
                const decoded = verifyToken(tokenParam);
                req.walletAddress = decoded.wallet;
            } catch (e) { /* invalid token - proceed as anonymous */ }
        }

        const allowed = await checkReconstructAccess(manifestTxId, req, res);
        if (!allowed) return;

        // Hand off to SSE streamer (it manages the response lifecycle)
        await reconstructService.streamReconstruction(manifestTxId, res);

    } catch (err) {
        console.error('Reconstruct stream error:', err.message);
        // If headers haven't been sent yet, send JSON error
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to start reconstruction stream' });
        }
    }
});


/**
 * GET /api/reconstruct/:manifestTxId
 * Direct reconstruction - returns the reassembled file.
 * Used as a fallback if SSE isn't available, or for programmatic access.
 */
router.get('/reconstruct/:manifestTxId', optionalAuth, async (req, res) => {
    try {
        const { manifestTxId } = req.params;
        if (!/^[a-f0-9]{64}$/i.test(manifestTxId)) {
            return res.status(400).json({ error: 'Invalid transaction ID format' });
        }

        const allowed = await checkReconstructAccess(manifestTxId, req, res);
        if (!allowed) return;

        const result = await reconstructService.reconstructDocument(manifestTxId);

        const fileName = result.manifest.fileName || 'document.pdf';
        const fileType = result.manifest.fileType || 'application/pdf';

        res.set({
            'Content-Type': fileType,
            'Content-Disposition': `inline; filename="${fileName}"`,
            'Content-Length': result.file.length,
            'X-KaspaNotary-Verified': result.verified ? 'true' : 'false',
            'X-KaspaNotary-Hash': result.fileHash,
            'X-KaspaNotary-Chunks': result.totalChunks,
        });

        res.send(result.file);

    } catch (err) {
        console.error('Reconstruct error:', err.message);
        if (err.message.includes('not a kaspanotary') || err.message.includes('no payload')) {
            return res.status(400).json({ error: 'Not a valid kaspanotary manifest', detail: err.message });
        }
        if (err.message.includes('Kaspa API error')) {
            return res.status(502).json({ error: 'Could not reach the Kaspa network', detail: err.message });
        }
        res.status(500).json({ error: 'Failed to reconstruct document', detail: err.message });
    }
});


/**
 * GET /api/reconstruct/:manifestTxId/info
 * Returns manifest metadata without downloading the full file. Public, no auth.
 */
router.get('/reconstruct/:manifestTxId/info', async (req, res) => {
    try {
        const { manifestTxId } = req.params;
        if (!/^[a-f0-9]{64}$/i.test(manifestTxId)) {
            return res.status(400).json({ error: 'Invalid transaction ID format' });
        }

        const manifest = await reconstructService.fetchManifest(manifestTxId);

        res.json({
            success: true,
            manifest: {
                protocol: manifest.protocol,
                version: manifest.version,
                title: manifest.title,
                fileName: manifest.fileName,
                fileSize: manifest.fileSize,
                fileType: manifest.fileType,
                fileHash: manifest.fileHash,
                chunkCount: manifest.chunkCount,
                chunkTxIds: manifest.chunkTxIds,
                creatorAddress: manifest.creatorAddress,
                counterpartyAddress: manifest.counterpartyAddress,
                timestamp: manifest.timestamp,
                note: manifest.note || null,
            }
        });

    } catch (err) {
        console.error('Manifest info error:', err.message);
        if (err.message.includes('not a kaspanotary') || err.message.includes('no payload')) {
            return res.status(400).json({ error: 'Not a valid kaspanotary manifest', detail: err.message });
        }
        res.status(500).json({ error: 'Failed to fetch manifest', detail: err.message });
    }
});

module.exports = router;
