-- KaspaNotary Database Schema
-- Standalone database — not shared with Kasla

CREATE DATABASE IF NOT EXISTS kaspa_notary CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE kaspa_notary;

-- Users table: lightweight, wallet-address-based identity
CREATE TABLE IF NOT EXISTS notary_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    wallet_address VARCHAR(80) NOT NULL UNIQUE,
    email VARCHAR(255) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_wallet (wallet_address)
) ENGINE=InnoDB;

-- Documents table: the core record
CREATE TABLE IF NOT EXISTS notary_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    doc_uuid VARCHAR(36) NOT NULL UNIQUE,
    
    -- Parties
    creator_wallet_address VARCHAR(80) NOT NULL,
    creator_email VARCHAR(255) DEFAULT NULL,
    counterparty_wallet_address VARCHAR(80) DEFAULT NULL,
    counterparty_email VARCHAR(255) NOT NULL,
    
    -- Document info
    title VARCHAR(255) NOT NULL,
    note TEXT DEFAULT NULL,
    original_file_path VARCHAR(500) NOT NULL,
    signed_file_path VARCHAR(500) DEFAULT NULL,
    original_hash VARCHAR(64) NOT NULL,
    signed_hash VARCHAR(64) DEFAULT NULL,
    file_size INT DEFAULT NULL,
    
    -- Signatures (JSON: { type: 'typed'|'drawn', value: '...', timestamp: '...' })
    creator_signature JSON DEFAULT NULL,
    counterparty_signature JSON DEFAULT NULL,
    signature_fields JSON DEFAULT NULL,
    
    -- Blockchain transactions
    creator_tx_id VARCHAR(100) DEFAULT NULL,
    counterparty_tx_id VARCHAR(100) DEFAULT NULL,
    seal_tx_id VARCHAR(100) DEFAULT NULL,
    
    -- Payment
    payment_tx_id VARCHAR(100) DEFAULT NULL,
    payment_amount_kas DECIMAL(18,8) DEFAULT NULL,
    payment_confirmed_at DATETIME DEFAULT NULL,
    
    -- Status flow: draft → paid → pending_cosign → pending_finalization → notarized
    status ENUM('draft', 'paid', 'pending_cosign', 'pending_finalization', 'notarized', 'expired', 'cancelled') DEFAULT 'draft',
    
    -- Invite
    invite_token VARCHAR(64) DEFAULT NULL,
    invite_sent_at DATETIME DEFAULT NULL,
    
    -- Timestamps
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    creator_signed_at DATETIME DEFAULT NULL,
    counterparty_signed_at DATETIME DEFAULT NULL,
    notarized_at DATETIME DEFAULT NULL,
    expires_at DATETIME DEFAULT NULL,
    
    INDEX idx_creator (creator_wallet_address),
    INDEX idx_counterparty_email (counterparty_email),
    INDEX idx_counterparty_wallet (counterparty_wallet_address),
    INDEX idx_status (status),
    INDEX idx_invite_token (invite_token),
    INDEX idx_doc_uuid (doc_uuid)
) ENGINE=InnoDB;

-- Audit log
CREATE TABLE IF NOT EXISTS notary_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    doc_uuid VARCHAR(36) DEFAULT NULL,
    wallet_address VARCHAR(80) DEFAULT NULL,
    action VARCHAR(50) NOT NULL,
    details JSON DEFAULT NULL,
    ip_address VARCHAR(45) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_doc_uuid (doc_uuid),
    INDEX idx_action (action),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;
