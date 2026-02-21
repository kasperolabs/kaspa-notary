-- Migration: 3-TX model → Single TX model
-- Run: mysql -u notary -p kaspa_notary < migrate_single_tx.sql

ALTER TABLE notary_documents DROP COLUMN IF EXISTS creator_tx_id;
ALTER TABLE notary_documents DROP COLUMN IF EXISTS counterparty_tx_id;
ALTER TABLE notary_documents DROP COLUMN IF EXISTS creator_sign_method;
ALTER TABLE notary_documents DROP COLUMN IF EXISTS counterparty_sign_method;
