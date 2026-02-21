const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR || '/var/www/notary/documents';

function hashBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function hashFile(filePath) {
    const buffer = await fs.readFile(filePath);
    return hashBuffer(buffer);
}

async function storeDocument(fileBuffer, docUuid, originalName) {
    const docDir = path.join(DOCUMENTS_DIR, docUuid);
    await fs.mkdir(docDir, { recursive: true });
    const ext = path.extname(originalName).toLowerCase() || '.pdf';
    const filePath = path.join(docDir, 'original' + ext);
    await fs.writeFile(filePath, fileBuffer);
    const hash = hashBuffer(fileBuffer);
    return { filePath, hash, fileSize: fileBuffer.length };
}

async function getOriginalPdf(filePath) {
    return fs.readFile(filePath);
}

function generateInviteToken() {
    return crypto.randomBytes(32).toString('hex');
}

module.exports = {
    hashBuffer, hashFile, storeDocument, getOriginalPdf, generateInviteToken
};
