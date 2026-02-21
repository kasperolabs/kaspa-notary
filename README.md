# KaspaNotary

**Seal agreements on the Kaspa blockchain. Two parties, one immutable witness.**

KaspaNotary is a document notarization service built on the [Kaspa](https://kaspa.org) blockDAG. It allows two parties to upload a PDF, sign it, and permanently seal the agreement on-chain — creating cryptographic proof that both parties agreed to a specific document at a specific time.

No one can backdate it. No one can alter it. Anyone can verify it.

Built by [Kaspero Labs LLC](https://kaspero.com) (Wyoming).

---

## How it works

1. **Party A** uploads a PDF, signs it, and pays a small notary fee
2. **Party B** receives an invite link, reviews the document, connects any Kaspa wallet, and signs
3. A **seal transaction** is recorded on the Kaspa blockchain containing both wallet addresses and the document's SHA-256 hash

The document's cryptographic fingerprint is now permanently embedded in an immutable public ledger. Change one pixel of the PDF and the hash won't match — tampering is immediately detectable.

## What gets stored on-chain

A single Kaspa transaction with a structured payload:

```
NOTARY:1|kaspa:party_a_address|kaspa:party_b_address|sha256_hash_of_pdf
```

The document itself is **never** on-chain — only its hash. The blockchain proves *what* was agreed, *who* agreed, and *when*.

## Tech stack

- **Backend:** Node.js / Express / MySQL
- **Frontend:** Vanilla JS (single-page app)
- **Blockchain:** Kaspa (via Keystone API for seal transactions)
- **Payments:** KasperoPay widget
- **PDF rendering:** pdf.js (frontend)

## Wallet support

KaspaNotary is wallet-agnostic. Any Kaspa wallet works:

- KasWare (browser extension)
- Kastle (browser extension)
- Keystone (browser extension or custodied account)
- Mobile wallets (via KasperoPay QR flow)

## Status

Early production. Core flow works end-to-end: upload → sign → pay → invite → countersign → auto-seal → email receipts. Active development on UI polish and additional features.

## Use cases

- Freelance contracts
- Rental agreements
- Intellectual property timestamps
- Partnership agreements
- Research paper priority
- Any document where you need provable, timestamped agreement between two parties

## License

Proprietary — Kaspero Labs LLC. All rights reserved.

---

*A digital notary service that happens to be powered by blockchain, not a blockchain app that happens to notarize.*
