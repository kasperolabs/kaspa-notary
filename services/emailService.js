const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shortAddr(addr) {
    return addr ? addr.substring(0, 14) + '...' + addr.slice(-6) : '';
}

// Shared email chrome (header + footer wrapper)
function emailWrap(subtitle, bodyHtml) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
    <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <div style="background: #1a2332; padding: 24px; text-align: center;">
                <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">Kaspa Notary</h1>
                <p style="margin: 6px 0 0 0; color: rgba(255,255,255,0.6); font-size: 13px;">${escapeHtml(subtitle)}</p>
            </div>
            
            <!-- Body -->
            <div style="padding: 32px 24px;">
                ${bodyHtml}
            </div>
            
            <!-- Footer -->
            <div style="background: #f8fafc; padding: 20px 24px; border-top: 1px solid #e2e8f0;">
                <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center;">
                    Kaspa Notary by Kaspero Labs &middot; <a href="https://kaspanotary.com" style="color: #94a3b8;">kaspanotary.com</a>
                </p>
            </div>
            
        </div>
    </div>
</body>
</html>`;
}

function detailRow(label, value, isLink, linkHref) {
    const valStyle = 'padding: 10px 0; color: #1e293b; font-family: "Courier New", monospace; font-size: 11px; word-break: break-all;';
    const val = isLink
        ? `<a href="${linkHref}" style="color: #2563eb; font-family: 'Courier New', monospace; font-size: 11px; text-decoration: none;">${escapeHtml(value)}</a>`
        : `<span style="${valStyle}">${escapeHtml(value)}</span>`;
    return `<tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px 0; color: #64748b; width: 130px; font-size: 13px; vertical-align: top;">${label}</td>
        <td style="${valStyle}">${val}</td>
    </tr>`;
}

/**
 * Send invite email to counterparty (two-party only)
 */
async function sendInviteEmail(to, { title, creatorAddress, note, inviteUrl }) {
    try {
        const safeTitle = escapeHtml(title);
        const safeNote = note ? escapeHtml(note) : '';

        const body = `
            <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #1a2332; text-align: center;">
                Document Signing Request
            </h2>
            <p style="margin: 0 0 24px 0; font-size: 14px; color: #64748b; text-align: center;">
                You've been invited to review and sign a document on the Kaspa blockchain.
            </p>
            
            <!-- Document Title -->
            <div style="text-align: center; margin-bottom: 24px;">
                <p style="margin: 0; font-size: 13px; color: #64748b;">Document</p>
                <p style="margin: 8px 0 0 0; font-size: 22px; font-weight: 600; color: #1a2332;">${safeTitle}</p>
            </div>
            
            <!-- From -->
            <div style="border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; padding: 14px 0; margin-bottom: 24px;">
                <p style="margin: 0; font-size: 13px; color: #64748b;">From: <span style="color: #1e293b; font-weight: 500; font-family: 'Courier New', monospace; font-size: 12px;">${shortAddr(creatorAddress)}</span></p>
            </div>
            
            ${safeNote ? `
            <!-- Note -->
            <div style="background: #f8fafc; padding: 14px 16px; margin-bottom: 24px; border-radius: 6px; border-left: 3px solid #e2e8f0;">
                <p style="margin: 0; font-size: 13px; color: #64748b;">Note from sender:</p>
                <p style="margin: 6px 0 0 0; font-size: 14px; color: #1e293b;">${safeNote}</p>
            </div>
            ` : ''}
            
            <!-- CTA -->
            <div style="text-align: center; margin-bottom: 24px;">
                <a href="${inviteUrl}"
                   style="display: inline-block; background: #1a2332; color: white; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px;">
                    Review &amp; Sign Document
                </a>
            </div>
            
            <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center;">
                You'll need a Kaspa wallet (KasWare, Kastle, Kasla, etc.) to sign. No account required.
            </p>
        `;

        const html = emailWrap('by Kaspero Labs', body);

        const mailOptions = {
            from: process.env.SMTP_FROM || 'Kaspa Notary <kaspanotary@gmail.com>',
            to,
            subject: `Sign request: ${safeTitle}`,
            html
        };

        console.log(`Sending notary invite email to: ${to}`);
        const result = await transporter.sendMail(mailOptions);
        console.log(`Notary invite email sent to: ${to}`, result.messageId);
        return true;

    } catch (error) {
        console.error('Failed to send notary invite email:', error);
        throw error;
    }
}

/**
 * Send notarized receipt — dynamic for single-signer vs two-party
 * 
 * @param {string} to - recipient email
 * @param {object} data
 * @param {string} data.title - document title
 * @param {string} data.proofUrl - URL to proof page
 * @param {string} data.sealTxId - blockchain transaction ID
 * @param {string} data.documentHash - SHA-256 of the PDF
 * @param {string} data.partyAWallet - creator wallet address
 * @param {string|null} data.partyBWallet - counterparty wallet (null = single-signer)
 * @param {string} data.notarizedAt - ISO date string
 * @param {string} data.explorerUrl - block explorer base URL
 */
async function sendNotarizedEmail(to, { title, proofUrl, sealTxId, documentHash, partyAWallet, partyBWallet, notarizedAt, explorerUrl }) {
    try {
        const safeTitle = escapeHtml(title);
        const isSingle = !partyBWallet;
        const shortTx = sealTxId ? sealTxId.substring(0, 24) + '...' : '';
        const txLink = (explorerUrl && sealTxId) ? `${explorerUrl}${sealTxId}` : '#';
        const dateStr = notarizedAt
            ? new Date(notarizedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
            : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

        // Dynamic description
        const description = isSingle
            ? 'Your document has been permanently sealed on the Kaspa blockchain.'
            : 'Both parties have signed and this document has been permanently sealed on the Kaspa blockchain.';

        // Build detail rows
        let rows = '';
        rows += detailRow('Date', dateStr);
        rows += detailRow('Document Hash', documentHash || '');

        if (isSingle) {
            // Single signer — just show "Signer" not "Party A"
            rows += detailRow('Signer', shortAddr(partyAWallet));
        } else {
            rows += detailRow('Party A', shortAddr(partyAWallet));
            rows += detailRow('Party B', shortAddr(partyBWallet));
        }

        // Seal TX is the last row — remove its bottom border
        const txRow = `<tr>
            <td style="padding: 10px 0; color: #64748b; width: 130px; font-size: 13px; vertical-align: top;">Seal Transaction</td>
            <td style="padding: 10px 0;"><a href="${txLink}" style="color: #2563eb; font-family: 'Courier New', monospace; font-size: 11px; text-decoration: none;">${escapeHtml(shortTx)}</a></td>
        </tr>`;

        const body = `
            <!-- Seal badge -->
            <div style="text-align: center; margin-bottom: 24px;">
                <div style="width: 56px; height: 56px; background: #d1fae5; border: 2px solid #a7f3d0; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; font-size: 28px;">&#10003;</div>
                <h2 style="margin: 0 0 6px 0; font-size: 20px; color: #1a2332;">Document Sealed</h2>
                <p style="margin: 0; font-size: 18px; font-weight: 600; color: #1e293b;">${safeTitle}</p>
            </div>
            
            <p style="margin: 0 0 20px 0; font-size: 14px; color: #64748b; text-align: center;">
                ${description}
            </p>
            
            <!-- Proof details -->
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
                <table style="width: 100%; border-collapse: collapse;">
                    ${rows}
                    ${txRow}
                </table>
            </div>
            
            <p style="margin: 0 0 24px 0; font-size: 12px; color: #94a3b8; text-align: center;">
                To verify: visit the proof page and drop your copy of the PDF to compare its fingerprint against the on-chain record.
            </p>
            
            <!-- CTA -->
            <div style="text-align: center;">
                <a href="${proofUrl}"
                   style="display: inline-block; background: #1a2332; color: white; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px;">
                    View Proof Page
                </a>
            </div>
        `;

        const html = emailWrap('Certificate of Notarization', body);

        const mailOptions = {
            from: process.env.SMTP_FROM || 'Kaspa Notary <kaspanotary@gmail.com>',
            to,
            subject: `Notarized: ${safeTitle}`,
            html
        };

        console.log(`Sending notarized email to: ${to}`);
        const result = await transporter.sendMail(mailOptions);
        console.log(`Notarized email sent to: ${to}`, result.messageId);
        return true;

    } catch (error) {
        console.error('Failed to send notarized email:', error);
        return false;
    }
}

module.exports = {
    sendInviteEmail,
    sendNotarizedEmail
};
