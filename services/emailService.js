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
    return addr ? addr.substring(0, 14) + '...' + addr.slice(-6) : 'A Kaspa Notary user';
}

/**
 * Send invite email to counterparty
 */
async function sendInviteEmail(to, { title, creatorAddress, note, inviteUrl }) {
    try {
        const safeTitle = escapeHtml(title);
        const safeNote = note ? escapeHtml(note) : '';

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                    <div style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                        
                        <!-- Header -->
                        <div style="background: #1a365d; padding: 24px; text-align: center;">
                            <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">Kaspa Notary</h1>
                            <p style="margin: 6px 0 0 0; color: rgba(255,255,255,0.7); font-size: 13px;">by Kaspero Labs</p>
                        </div>
                        
                        <!-- Body -->
                        <div style="padding: 32px 24px;">
                            
                            <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #1a365d; text-align: center;">
                                Document Signing Request
                            </h2>
                            <p style="margin: 0 0 24px 0; font-size: 14px; color: #64748b; text-align: center;">
                                You've been asked to review and sign a document on the Kaspa blockchain.
                            </p>
                            
                            <!-- Document Title -->
                            <div style="text-align: center; margin-bottom: 24px;">
                                <p style="margin: 0; font-size: 14px; color: #64748b;">Document</p>
                                <p style="margin: 8px 0 0 0; font-size: 24px; font-weight: 600; color: #1a365d;">${safeTitle}</p>
                            </div>
                            
                            <!-- From -->
                            <div style="border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; padding: 16px 0; margin-bottom: 24px;">
                                <p style="margin: 0; font-size: 14px; color: #64748b;">From: <span style="color: #1e293b; font-weight: 500;">${shortAddr(creatorAddress)}</span></p>
                            </div>
                            
                            ${safeNote ? `
                            <!-- Note -->
                            <div style="background: #f8fafc; padding: 16px; margin-bottom: 24px; border-radius: 4px;">
                                <p style="margin: 0; font-size: 14px; color: #64748b;">Note:</p>
                                <p style="margin: 8px 0 0 0; font-size: 15px; color: #1e293b;">"${safeNote}"</p>
                            </div>
                            ` : ''}
                            
                            <!-- CTA Button -->
                            <div style="text-align: center; margin-bottom: 24px;">
                                <a href="${inviteUrl}"
                                   style="display: inline-block; background: #1a365d; color: white; padding: 14px 32px; border-radius: 4px; text-decoration: none; font-weight: 500; font-size: 15px;">
                                    Review &amp; Sign Document
                                </a>
                            </div>
                            
                            <p style="margin: 0; font-size: 13px; color: #64748b; text-align: center;">
                                You'll need a Kaspa wallet (KasWare, Kastle, etc.) to sign. No account required.
                            </p>
                            
                        </div>
                        
                        <!-- Footer -->
                        <div style="background: #f8fafc; padding: 20px 24px; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center;">
                                Kaspa Notary by Kaspero Labs
                            </p>
                        </div>
                        
                    </div>
                </div>
            </body>
            </html>
        `;

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
 * Send notarized receipt to a party — includes all proof details
 */
async function sendNotarizedEmail(to, { title, proofUrl, sealTxId, documentHash, partyAWallet, partyBWallet, notarizedAt, explorerUrl }) {
    try {
        const safeTitle = escapeHtml(title);
        const shortTx = sealTxId ? sealTxId.substring(0, 20) + '...' : '—';
        const shortHash = documentHash ? documentHash.substring(0, 20) + '...' : '—';
        const txLink = (explorerUrl && sealTxId) ? `${explorerUrl}${sealTxId}` : '#';
        const dateStr = notarizedAt ? new Date(notarizedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                    <div style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                        
                        <!-- Header -->
                        <div style="background: #1a365d; padding: 24px; text-align: center;">
                            <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">Kaspa Notary</h1>
                            <p style="margin: 6px 0 0 0; color: rgba(255,255,255,0.7); font-size: 13px;">Certificate of Notarization</p>
                        </div>
                        
                        <!-- Seal -->
                        <div style="padding: 32px 24px 16px; text-align: center;">
                            <div style="width: 56px; height: 56px; background: #d1fae5; border: 2px solid #a7f3d0; border-radius: 50%; margin: 0 auto 16px; line-height: 56px; font-size: 28px;">✓</div>
                            <h2 style="margin: 0 0 4px 0; font-size: 20px; color: #1a365d;">Document Sealed</h2>
                            <p style="margin: 0; font-size: 16px; font-weight: 600; color: #1e293b;">${safeTitle}</p>
                        </div>
                        
                        <!-- Details -->
                        <div style="padding: 0 24px 24px;">
                            <p style="margin: 0 0 16px 0; font-size: 14px; color: #64748b; text-align: center;">
                                Both parties have signed and this document has been permanently sealed on the Kaspa blockchain.
                            </p>
                            
                            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 20px 0;">
                                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                    <tr style="border-bottom: 1px solid #e2e8f0;">
                                        <td style="padding: 8px 0; color: #64748b; width: 120px;">Date</td>
                                        <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">${dateStr}</td>
                                    </tr>
                                    <tr style="border-bottom: 1px solid #e2e8f0;">
                                        <td style="padding: 8px 0; color: #64748b;">Document Hash</td>
                                        <td style="padding: 8px 0; color: #1e293b; font-family: 'Courier New', monospace; font-size: 11px; word-break: break-all;">${escapeHtml(documentHash || '')}</td>
                                    </tr>
                                    <tr style="border-bottom: 1px solid #e2e8f0;">
                                        <td style="padding: 8px 0; color: #64748b;">Seal Transaction</td>
                                        <td style="padding: 8px 0;"><a href="${txLink}" style="color: #2563eb; font-family: 'Courier New', monospace; font-size: 11px; text-decoration: none;">${escapeHtml(shortTx)}</a></td>
                                    </tr>
                                    <tr style="border-bottom: 1px solid #e2e8f0;">
                                        <td style="padding: 8px 0; color: #64748b;">Party A</td>
                                        <td style="padding: 8px 0; color: #1e293b; font-family: 'Courier New', monospace; font-size: 11px;">${shortAddr(partyAWallet)}</td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 8px 0; color: #64748b;">Party B</td>
                                        <td style="padding: 8px 0; color: #1e293b; font-family: 'Courier New', monospace; font-size: 11px;">${shortAddr(partyBWallet)}</td>
                                    </tr>
                                </table>
                            </div>
                            
                            <p style="margin: 0 0 20px 0; font-size: 12px; color: #94a3b8; text-align: center;">
                                To verify: download the PDF, compute its SHA-256 hash, and compare it to the hash stored in the blockchain transaction above.
                            </p>
                            
                            <!-- CTA -->
                            <div style="text-align: center;">
                                <a href="${proofUrl}"
                                   style="display: inline-block; background: #1a365d; color: white; padding: 14px 32px; border-radius: 4px; text-decoration: none; font-weight: 500; font-size: 15px;">
                                    View Proof &amp; Download PDF
                                </a>
                            </div>
                        </div>
                        
                        <!-- Footer -->
                        <div style="background: #f8fafc; padding: 20px 24px; border-top: 1px solid #e2e8f0;">
                            <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center;">
                                Kaspa Notary by Kaspero Labs · This is your permanent receipt.
                            </p>
                        </div>
                        
                    </div>
                </div>
            </body>
            </html>
        `;

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
