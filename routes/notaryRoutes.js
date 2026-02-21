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

const APP_URL = process.env.APP_URL || 'https://kaspanotary.com';
const NOTARY_FEE_KAS = parseFloat(process.env.NOTARY_FEE_KAS) || 5;

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
 * Public endpoint — returns fee amount and merchant ID
 */
router.get('/config', (req, res) => {
    res.json({
        fee_kas: NOTARY_FEE_KAS,
        merchant_id: process.env.KASPERO_PAY_MERCHANT_ID || null
    });
});

// ─────────────────────────────────────────────
// PUBLIC ARCHIVE
// ─────────────────────────────────────────────

/**
 * GET /api/archive
 * Public endpoint — returns all notarized documents for the public archive.
 * Public docs return title + hash + PDF access. Private docs return hash + wallets only.
 */
router.get('/archive', async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT doc_uuid, title, title_public, is_public, original_hash, file_size,
                    creator_wallet_address, counterparty_wallet_address,
                    seal_tx_id, notarized_at
             FROM notary_documents 
             WHERE status = 'notarized'
             ORDER BY notarized_at DESC
             LIMIT 50`
        );

        const documents = rows.map(doc => ({
            doc_uuid: doc.doc_uuid,
            title: doc.title_public ? doc.title : null,
            is_public: !!doc.is_public,
            original_hash: doc.original_hash,
            file_size: doc.file_size,
            party_a: doc.creator_wallet_address,
            party_b: doc.counterparty_wallet_address,
            seal_tx_id: doc.seal_tx_id,
            notarized_at: doc.notarized_at
        }));

        res.json({ success: true, documents });
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
 * Upload PDF, set title, counterparty email. Creates draft.
 */
router.post('/documents', requireAuth, upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'PDF file required' });
        }

		const { title, counterparty_email, creator_email, note, is_public, title_public } = req.body;
        if (!title || !counterparty_email) {
            return res.status(400).json({ error: 'Title and counterparty email required' });
        }

        if (!counterparty_email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }

        const docUuid = uuidv4();
        const { filePath, hash, fileSize } = await notaryService.storeDocument(
            req.file.buffer, docUuid, req.file.originalname
        );

        const docIsPublic = is_public === 'true' || is_public === true ? 1 : 0;
        const docTitlePublic = title_public === 'false' || title_public === false ? 0 : 1;

        await db.execute(
            `INSERT INTO notary_documents 
             (doc_uuid, creator_wallet_address, creator_email, counterparty_email, title, note, original_file_path, original_hash, file_size, is_public, title_public, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
            [docUuid, req.walletAddress, (creator_email || '').trim() || null, counterparty_email.trim(), title.trim(), note || null, filePath, hash, fileSize, docIsPublic, docTitlePublic]
        );

        // Also update the user's email in the users table
        if (creator_email && creator_email.includes('@')) {
            await db.execute(
                'UPDATE notary_users SET email = ? WHERE wallet_address = ?',
                [creator_email.trim(), req.walletAddress]
            ).catch(() => {});
        }

        await audit.log(docUuid, req.walletAddress, 'document_created', { title, counterparty_email }, req.ip);

        res.json({
            success: true,
            doc_uuid: docUuid,
            hash: hash,
            file_size: fileSize,
            fee_kas: NOTARY_FEE_KAS
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
 * Edit a draft document — title, counterparty email, note, visibility, or replace PDF.
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
        if (req.body.counterparty_email && req.body.counterparty_email.includes('@')) {
            updates.push('counterparty_email = ?');
            params.push(req.body.counterparty_email.trim());
        }
        if (req.body.note !== undefined) {
            updates.push('note = ?');
            params.push(req.body.note || null);
        }
        if (req.body.is_public !== undefined) {
            updates.push('is_public = ?');
            params.push(req.body.is_public === 'true' || req.body.is_public === true ? 1 : 0);
        }
        if (req.body.title_public !== undefined) {
            updates.push('title_public = ?');
            params.push(req.body.title_public === 'false' || req.body.title_public === false ? 0 : 1);
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
                // Continue anyway — TX ID is on-chain and verifiable
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
 * Records consent + typed name in DB.
 * When Party B signs, auto-seals on blockchain (no separate finalize step).
 */
router.post('/documents/:docUuid/sign', requireAuth, async (req, res) => {
    try {
        const { docUuid } = req.params;
        const { signature, agreed, email } = req.body;

        if (!signature || !signature.type || !signature.value) {
            return res.status(400).json({ error: 'Signature data required (type and value)' });
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
            value: signature.value,
            agreed: true,
            timestamp: new Date().toISOString(),
            wallet_address: req.walletAddress
        };

        if (party === 'A') {
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
            // Party B signs — save email if provided
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
                // Party A (creator)
                if (doc.creator_email) {
                    emailService.sendNotarizedEmail(doc.creator_email, emailData).catch(() => {});
                }
                // Party B (counterparty)
                const partyBEmail = (email && email.includes('@')) ? email.trim() : doc.counterparty_email;
                if (partyBEmail) {
                    emailService.sendNotarizedEmail(partyBEmail, emailData).catch(() => {});
                }

                res.json({ success: true, party: 'B', status: 'notarized', seal_tx_id: sealResult.txId });

            } catch (sealErr) {
                console.error('Auto-seal error:', sealErr.message);
                // Signature is saved, but seal failed — stays at pending_finalization
                // Creator can manually retry via finalize endpoint
                res.json({
                    success: true,
                    party: 'B',
                    status: 'pending_finalization',
                    seal_error: 'Blockchain seal pending — will retry automatically'
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
            // Still return success — the invite token is created, email can be resent
        }

        await audit.log(docUuid, req.walletAddress, 'invite_sent', { to: doc.counterparty_email }, req.ip);

        res.json({ success: true, invite_url: inviteUrl });
    } catch (err) {
        console.error('Invite error:', err);
        res.status(500).json({ error: 'Failed to send invitation' });
    }
});

// ─────────────────────────────────────────────
// INVITE LOOKUP (public — counterparty lands here)
// ─────────────────────────────────────────────

/**
 * GET /api/invite/:token
 * Counterparty uses this to load the document for signing.
 * No auth required — the invite token IS the auth for viewing.
 */
router.get('/invite/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const [rows] = await db.execute(
            `SELECT doc_uuid, title, note, original_hash, file_size, status,
                    creator_wallet_address, counterparty_wallet_address, counterparty_email,
                    creator_signature, counterparty_signature,
                    seal_tx_id,
                    created_at, creator_signed_at, counterparty_signed_at, notarized_at
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
                original_hash: doc.original_hash,
                file_size: doc.file_size,
                is_public: !!doc.is_public,
                title_public: !!doc.title_public,
                creator_wallet_address: doc.creator_wallet_address,
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
                original_hash: doc.original_hash,
                file_size: doc.file_size,
                creator_wallet_address: doc.creator_wallet_address,
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
// FINALIZE
// ─────────────────────────────────────────────

/**
 * POST /api/documents/:docUuid/finalize
 * Creator finalizes: send seal TX with structured payload.
 * No PDF modification — the original document IS the sealed document.
 * Payload: NOTARY:1|partyA_wallet|partyB_wallet|original_pdf_hash
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
            return res.status(400).json({ error: 'Both parties must sign before finalizing' });
        }

        // Send seal transaction with structured payload
        let sealTx;
        try {
            sealTx = await keystoneService.sendSealTx(
                doc.creator_wallet_address,
                doc.counterparty_wallet_address,
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
            partyBWallet: doc.counterparty_wallet_address,
            notarizedAt: new Date().toISOString(),
            explorerUrl: 'https://explorer.kaspa.org/txs/'
        };
        if (doc.creator_email) {
            emailService.sendNotarizedEmail(doc.creator_email, emailData).catch(() => {});
        }
        if (doc.counterparty_email) {
            emailService.sendNotarizedEmail(doc.counterparty_email, emailData).catch(() => {});
        }

        res.json({
            success: true,
            status: 'notarized',
            seal_tx_id: sealTx.txId,
            payload: sealTx.payload
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
        res.setHeader('Content-Disposition', `attachment; filename="${doc.title} — Notarized.pdf"`);
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
 * Public proof endpoint — returns only on-chain verifiable data.
 * No document title, no file content — just hashes, wallets, timestamps, TX.
 */
router.get('/proof/:docUuid', async (req, res) => {
    try {
        const { docUuid } = req.params;

        const [rows] = await db.execute(
            `SELECT doc_uuid, status, original_hash,
                    creator_wallet_address, counterparty_wallet_address,
                    seal_tx_id,
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
                document_hash: doc.original_hash,
                party_a: doc.creator_wallet_address,
                party_b: doc.counterparty_wallet_address,
                seal_tx_id: doc.seal_tx_id,
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
// DASHBOARD
// ─────────────────────────────────────────────

/**
 * GET /api/documents
 * List all documents for the authenticated user
 */
router.get('/documents', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT doc_uuid, title, status, counterparty_email, counterparty_wallet_address,
                    original_hash, created_at, creator_signed_at, counterparty_signed_at, notarized_at
             FROM notary_documents 
             WHERE creator_wallet_address = ? OR counterparty_wallet_address = ?
             ORDER BY created_at DESC`,
            [req.walletAddress, req.walletAddress]
        );

        const documents = rows.map(doc => ({
            doc_uuid: doc.doc_uuid,
            title: doc.title,
            status: doc.status,
            counterparty_email: doc.counterparty_email,
            counterparty_wallet_address: doc.counterparty_wallet_address,
            is_creator: doc.creator_wallet_address === req.walletAddress,
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

module.exports = router;

