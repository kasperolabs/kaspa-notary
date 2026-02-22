(function() {
    'use strict';

    var state = {
        token: localStorage.getItem('notary_token') || null,
        walletAddress: localStorage.getItem('notary_wallet') || null,
        userEmail: localStorage.getItem('notary_email') || null,
        currentDoc: null,
        inviteToken: null,
        inviteDoc: null,
        uploadedFile: null,
        uploadedHash: null,
        feeKas: 5,
        merchantId: null,
        pendingDocUuid: null,
        pendingSig: null,
        pendingInviteUrl: null,
        archivePage: 1
    };

    var API = '/api';
    var EXPLORER = 'https://explorer.kaspa.org/txs/';

    // ── Helpers ──
    function $(id) { return document.getElementById(id); }
    function show(el) { if (typeof el === 'string') el = $(el); if (el) el.classList.remove('hidden'); }
    function hide(el) { if (typeof el === 'string') el = $(el); if (el) el.classList.add('hidden'); }
    function showScreen(id) { document.querySelectorAll('.screen').forEach(function(s) { s.classList.add('hidden'); }); show(id); window.scrollTo(0, 0); }
    function showLoading(t) { $('loading-text').textContent = t || 'Processing...'; show('loading'); }
    function hideLoading() { hide('loading'); }

    function toast(msg, type) {
        var t = $('toast');
        t.textContent = msg;
        t.className = 'toast ' + (type || 'info');
        show(t);
        setTimeout(function() { hide(t); }, 4000);
    }

    function truncAddr(a) { return a ? a.slice(0, 14) + '...' + a.slice(-6) : ''; }
    function formatDate(d) { if (!d) return ''; var o = new Date(d); return o.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + o.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
    function formatDateShort(d) { return d ? new Date(d).toISOString().slice(0, 10) : ''; }
    function formatSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
    function sha256(buf) { return crypto.subtle.digest('SHA-256', buf).then(function(h) { return Array.from(new Uint8Array(h)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''); }); }
    function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

    function categoryLabel(c) {
        return { contract: 'Contract', agreement: 'Agreement', nda: 'NDA', patent: 'Patent / IP', certificate: 'Certificate', other: 'Other' }[c] || 'Contract';
    }

    function statusLabel(s) {
        return { draft: 'Draft', paid: 'Paid - Ready to Sign', pending_cosign: 'Awaiting Countersignature', pending_finalization: 'Ready to Finalize', notarized: 'Notarized', expired: 'Expired', cancelled: 'Cancelled' }[s] || s;
    }

    function statusBanner(s) {
        var c = s === 'notarized' ? 'confirmed' : (s === 'pending_cosign' || s === 'pending_finalization') ? 'pending' : s === 'paid' ? 'paid' : 'draft';
        var icons = {
            draft: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
            paid: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
            pending: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>',
            confirmed: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>'
        };
        return '<div class="status-banner ' + c + '" id="doc-status-banner">' + icons[c] + ' ' + statusLabel(s) + '</div>';
    }

    function api(ep, opts) {
        opts = opts || {};
        var h = opts.headers || {};
        if (state.token && !h['Authorization']) h['Authorization'] = 'Bearer ' + state.token;
        if (!(opts.body instanceof FormData) && !h['Content-Type']) h['Content-Type'] = 'application/json';
        return fetch(API + ep, { method: opts.method || 'GET', headers: h, body: opts.body }).then(function(r) {
            if (r.status === 401) { disconnect(); throw new Error('Session expired'); }
            return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
        });
    }

    // ── PDF Rendering ──
    function renderPdf(url, canvasId) {
        if (!window.pdfjsLib) return Promise.resolve();
        var h = {};
        if (state.token) h['Authorization'] = 'Bearer ' + state.token;
        var canvas = $(canvasId);
        if (!canvas) return Promise.resolve();
        var container = canvas.parentElement;

        return fetch(url, { headers: h }).then(function(r) { return r.arrayBuffer(); }).then(function(d) {
            return pdfjsLib.getDocument({ data: d }).promise;
        }).then(function(pdf) {
            var extras = container.querySelectorAll('.pdf-page-extra');
            extras.forEach(function(e) { e.remove(); });

            var cw = container.clientWidth || 600;
            var renderPage = function(num) {
                return pdf.getPage(num).then(function(page) {
                    var c;
                    if (num === 1) {
                        c = canvas;
                    } else {
                        c = document.createElement('canvas');
                        c.className = 'pdf-page-extra';
                        c.style.width = '100%';
                        c.style.height = 'auto';
                        c.style.display = 'block';
                        c.style.borderTop = '1px solid #e2e5ea';
                        container.appendChild(c);
                    }
                    var uv = page.getViewport({ scale: 1 });
                    var sc = cw / uv.width;
                    var vp = page.getViewport({ scale: sc });
                    c.width = vp.width;
                    c.height = vp.height;
                    return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
                });
            };

            var chain = Promise.resolve();
            for (var i = 1; i <= pdf.numPages; i++) {
                (function(n) { chain = chain.then(function() { return renderPage(n); }); })(i);
            }
            return chain;
        }).catch(function(e) { console.error('PDF render:', e); });
    }

    // ── Wallet ──
    function connectWallet() {
        return new Promise(function(resolve) {
            if (window.KasperoPay && typeof KasperoPay.connect === 'function') {
                KasperoPay.connect({
                    onConnect: function(u) { finishAuth(u.address).then(resolve); },
                    onCancel: function() { resolve(false); }
                });
                return;
            }
            detectWallet().then(function(addr) {
                if (!addr) { toast('No Kaspa wallet detected. Install KasWare, Kastle, or Keystone extension.', 'error'); resolve(false); return; }
                finishAuth(addr).then(resolve);
            }).catch(function(e) { toast('Wallet error: ' + e.message, 'error'); resolve(false); });
        });
    }

    function detectWallet() {
        if (window.kasware) return window.kasware.requestAccounts().then(function(a) { return a[0]; });
        if (window.kastle) return window.kastle.connect('mainnet').then(function() { return window.kastle.getAccount(); }).then(function(a) { return a.address; });
        if (window.keystone) return window.keystone.requestAccounts().then(function(a) { return Array.isArray(a) ? a[0] : a; });
        return Promise.resolve(null);
    }

    function finishAuth(address) {
        return api('/auth/connect', { method: 'POST', body: JSON.stringify({ address: address }) }).then(function(d) {
            state.token = d.token;
            state.walletAddress = d.address;
            state.userEmail = d.email || null;
            localStorage.setItem('notary_token', d.token);
            localStorage.setItem('notary_wallet', d.address);
            if (d.email) localStorage.setItem('notary_email', d.email);
            updateHeader();
            return true;
        }).catch(function(e) { toast('Auth failed: ' + e.message, 'error'); return false; });
    }

    function disconnect() {
        state.token = null;
        state.walletAddress = null;
        state.userEmail = null;
        localStorage.removeItem('notary_token');
        localStorage.removeItem('notary_wallet');
        localStorage.removeItem('notary_email');
        if (window.KasperoPay && KasperoPay.disconnect) KasperoPay.disconnect();
        updateHeader();
        loadArchive();
    }

    function updateHeader() {
        if (state.walletAddress) {
            $('header-wallet-addr').textContent = truncAddr(state.walletAddress);
            show('header-wallet');
            hide('btn-connect');
            show('nav-auth');
            if ($('archive-hint')) hide('archive-hint');
        } else {
            hide('header-wallet');
            show('btn-connect');
            hide('nav-auth');
            if ($('archive-hint')) show('archive-hint');
        }
    }

    function setActiveNav(id) {
        document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
        if ($(id)) $(id).classList.add('active');
    }

    // ════════════════════════════════════════════
    // ARCHIVE (with search + filter + pagination)
    // ════════════════════════════════════════════

    function loadArchive() {
        showScreen('screen-archive');
        setActiveNav('nav-archive');
        state.archivePage = 1;
        fetchArchive();
    }

    function fetchArchive() {
        var q = $('archive-search-input') ? $('archive-search-input').value.trim() : '';
        var category = $('archive-filter-category') ? $('archive-filter-category').value : 'all';
        var period = $('archive-filter-period') ? $('archive-filter-period').value : 'all';
        var page = state.archivePage || 1;

        var params = '?page=' + page + '&limit=20';
        if (q) params += '&q=' + encodeURIComponent(q);
        if (category !== 'all') params += '&category=' + category;
        if (period !== 'all') params += '&period=' + period;

        api('/archive' + params).then(function(d) {
            var list = $('archive-list');
            list.innerHTML = '';

            if (!d.documents || !d.documents.length) {
                list.innerHTML = '<div class="dash-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg><p>No documents found</p></div>';
                hide('archive-pagination');
                return;
            }

            d.documents.forEach(function(doc) {
                var el = document.createElement('div');
                el.className = 'archive-card' + (doc.is_public ? ' public' : '');
                var title = doc.title ? esc(doc.title) : '<span class="private-label">Private Document</span>';
                var hashShort = (doc.original_hash || '').slice(0, 16) + '...';
                var isSingle = !doc.party_b;

                // Thumbnail preview area
                var preview = '';
                if (doc.is_public) {
                    preview = '<div class="archive-card-preview" id="preview-' + doc.doc_uuid + '"><canvas class="archive-thumb"></canvas></div>';
                } else {
                    preview = '<div class="archive-card-preview archive-card-private">' +
                        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>' +
                        '<span>Private Document</span>' +
                        '</div>';
                }

                var html = preview;
                html += '<div class="archive-card-body">';
                html += '<div class="archive-card-top">';
                html += '<div class="archive-card-title">' + title + '</div>';
                html += '<div class="archive-card-badges">';
                html += '<span class="category-pill">' + categoryLabel(doc.category) + '</span>';
                html += '<span class="status-pill notarized">Sealed</span>';
                html += '</div>';
                html += '</div>';
                html += '<div class="archive-card-meta">';
                html += '<span class="mono" style="font-size:11px;">' + esc(hashShort) + '</span>';
                html += '<span>' + formatDate(doc.notarized_at) + '</span>';
                html += '</div>';
                html += '<div class="archive-card-parties">';
                html += '<span>Party A: ' + truncAddr(doc.party_a) + '</span>';
                if (isSingle) {
                    html += '<span class="single-label">Single signature</span>';
                } else {
                    html += '<span>Party B: ' + truncAddr(doc.party_b) + '</span>';
                }
                html += '</div>';
                if (doc.seal_tx_id) {
                    html += '<div class="archive-card-tx"><a href="' + EXPLORER + doc.seal_tx_id + '" target="_blank" class="mono">Seal TX: ' + doc.seal_tx_id.slice(0, 16) + '...</a></div>';
                }
                html += '</div>'; // close archive-card-body
                el.innerHTML = html;
                el.style.cursor = 'pointer';
                el.onclick = function() { history.pushState(null, '', '/proof/' + doc.doc_uuid); loadProof(doc.doc_uuid); };
                list.appendChild(el);

                // Render PDF thumbnail for public docs
                if (doc.is_public) {
                    renderArchiveThumb(doc.doc_uuid);
                }
            });

            // Pagination
            var pg = d.pagination;
            if (pg && pg.pages > 1) {
                show('archive-pagination');
                $('archive-page-info').textContent = 'Page ' + pg.page + ' of ' + pg.pages + ' (' + pg.total + ' documents)';
                $('archive-prev').disabled = pg.page <= 1;
                $('archive-next').disabled = pg.page >= pg.pages;
            } else {
                hide('archive-pagination');
            }
        }).catch(function(e) { console.error('Archive load error:', e); });
    }

    function renderArchiveThumb(uuid) {
        if (!window.pdfjsLib) return;
        var container = document.getElementById('preview-' + uuid);
        if (!container) return;
        var canvas = container.querySelector('canvas');
        if (!canvas) return;

        fetch(API + '/archive/' + uuid + '/pdf').then(function(r) {
            if (!r.ok) throw new Error('PDF fetch failed');
            return r.arrayBuffer();
        }).then(function(data) {
            return pdfjsLib.getDocument({ data: data }).promise;
        }).then(function(pdf) {
            return pdf.getPage(1);
        }).then(function(page) {
            var thumbWidth = container.clientWidth || 280;
            var uv = page.getViewport({ scale: 1 });
            var scale = thumbWidth / uv.width;
            var vp = page.getViewport({ scale: scale });
            canvas.width = vp.width;
            canvas.height = vp.height;
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        }).catch(function() {
            // If PDF can't load, show fallback
            container.innerHTML = '<div class="archive-thumb-fallback"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></div>';
        });
    }

    // ════════════════════════════════════════════
    // HASH A FILE (public tool)
    // ════════════════════════════════════════════

    function initHashTool() {
        var zone = $('hash-upload-zone');
        if (!zone) return;

        zone.onclick = function() { $('hash-file-input').click(); };
        $('hash-file-input').onchange = function(e) { if (e.target.files[0]) hashFile(e.target.files[0]); };
        zone.ondragover = function(e) { e.preventDefault(); zone.classList.add('drag-over'); };
        zone.ondragleave = function() { zone.classList.remove('drag-over'); };
        zone.ondrop = function(e) { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) hashFile(e.dataTransfer.files[0]); };

        $('hash-copy').onclick = function() {
            var val = $('hash-value').textContent;
            if (val) { navigator.clipboard.writeText(val); toast('Hash copied', 'info'); }
        };

        $('hash-reset').onclick = function() {
            hide('hash-result');
            show('hash-upload-zone');
            $('hash-file-input').value = '';
        };
    }

    function hashFile(file) {
        if (!file) return;
        if (file.type !== 'application/pdf') { toast('Only PDF files.', 'error'); return; }
        if (file.size > 10485760) { toast('Max 10 MB.', 'error'); return; }

        file.arrayBuffer().then(sha256).then(function(h) {
            $('hash-file-name').textContent = file.name;
            $('hash-file-meta').textContent = formatSize(file.size);
            $('hash-value').textContent = h;
            hide('hash-upload-zone');
            show('hash-result');
        });
    }

    // ════════════════════════════════════════════
    // DASHBOARD (My Documents)
    // ════════════════════════════════════════════

    function loadDashboard() {
        showScreen('screen-dashboard');
        setActiveNav('nav-my-docs');
        api('/documents').then(function(d) {
            var list = $('dash-list');
            list.innerHTML = '';
            if (!d.documents.length) {
                list.innerHTML = '<div class="dash-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg><p>No documents yet</p><p class="small">Create your first notarized document.</p></div>';
                return;
            }
            d.documents.forEach(function(doc) {
                var el = document.createElement('div');
                el.className = 'dash-item';
                el.onclick = function() { history.pushState(null, '', '/document/' + doc.doc_uuid); loadDocument(doc.doc_uuid); };
                var meta = doc.single_signer ? 'Single signature' : esc(doc.counterparty_email || '');
                meta += ' · ' + formatDate(doc.created_at);
                el.innerHTML = '<div class="dash-item-left"><div class="dash-item-title">' + esc(doc.title) + '</div><div class="dash-item-meta">' + meta + '</div></div><div class="dash-item-right"><span class="category-pill category-sm">' + categoryLabel(doc.category) + '</span><span class="status-pill ' + doc.status + '">' + statusLabel(doc.status) + '</span></div>';
                list.appendChild(el);
            });
        }).catch(function(e) { toast(e.message, 'error'); });
    }

    // ════════════════════════════════════════════
    // CREATE DOCUMENT (Wizard)
    // ════════════════════════════════════════════

    var wizardStep = 1;

    function showCreate() {
        showScreen('screen-create');
        setActiveNav('nav-new-doc');
        wizardStep = 1;

        // Reset all state
        state.uploadedFile = null;
        state.uploadedHash = null;
        state.pendingDocUuid = null;
        state.pendingSig = null;
        state.pendingInviteUrl = null;

        // Reset form fields
        $('input-title').value = '';
        $('input-category').value = 'contract';
        $('input-note').value = '';
        $('input-creator-email').value = state.userEmail || '';
        $('input-email').value = '';
        $('input-title-public').checked = true;
        $('input-is-public').checked = false;
        $('create-sig-name').value = '';
        $('create-agree').checked = false;
        $('toggle-counterparty').checked = false;

        // Reset file upload
        hide('file-preview');
        show('upload-zone');
        $('file-input').value = '';

        // Reset UI
        hide('party-b-section');
        hide('payment-section');
        $('btn-create-submit').disabled = true;
        $('btn-create-submit').textContent = 'Upload, Sign & Pay';
        $('cost-fee').textContent = state.feeKas + ' KAS';

        // Show wallet address on party card
        if ($('party-a-wallet')) {
            $('party-a-wallet').textContent = state.walletAddress ? truncAddr(state.walletAddress) : '';
        }

        updatePartySummary();
        showWizardStep(1);
    }

    function showWizardStep(step) {
        wizardStep = step;
        for (var i = 1; i <= 4; i++) {
            var panel = $('create-panel-' + i);
            var stepEl = $('wiz-step-' + i);
            if (panel) { if (i === step) show(panel); else hide(panel); }
            if (stepEl) {
                stepEl.classList.remove('active', 'completed');
                if (i < step) stepEl.classList.add('completed');
                if (i === step) stepEl.classList.add('active');
            }
        }
    }

    function checkStep1() {
        var t = $('input-title').value.trim();
        var hasFile = !!state.uploadedFile;
        $('btn-wiz-next-1').disabled = !(t && hasFile);
    }

    function checkStep3() {
        var hasSig = $('create-sig-name').value.trim() && $('create-agree').checked;
        $('btn-create-submit').disabled = !hasSig;
    }

    function updatePartySummary() {
        var hasCounterparty = $('toggle-counterparty').checked;
        var text = hasCounterparty
            ? 'Two-party agreement - counterparty will receive an invite to review and sign.'
            : 'Single-signature document - will be sealed immediately after you sign.';
        if ($('party-summary-text')) $('party-summary-text').textContent = text;
    }

    function checkStep2() {
        var hasCounterparty = $('toggle-counterparty').checked;
        var creatorEmail = $('input-creator-email').value.trim();
        if (hasCounterparty) {
            var cpEmail = $('input-email').value.trim();
            return creatorEmail && creatorEmail.includes('@') && cpEmail && cpEmail.includes('@');
        }
        return creatorEmail && creatorEmail.includes('@');
    }

    function pickFile(file) {
        if (!file) return;
        if (file.type !== 'application/pdf') { toast('Only PDF files.', 'error'); return; }
        if (file.size > 10485760) { toast('Max 10 MB.', 'error'); return; }
        state.uploadedFile = file;
        file.arrayBuffer().then(sha256).then(function(h) {
            state.uploadedHash = h;
            $('preview-name').textContent = file.name;
            $('preview-meta').textContent = formatSize(file.size) + ' - SHA-256: ' + h.slice(0, 12) + '...';
            hide('upload-zone');
            show('file-preview');
            checkStep1();
        });
    }

    function submitCreate() {
        if (!state.uploadedFile) return;
        var sigName = $('create-sig-name').value.trim();
        var agreed = $('create-agree').checked;
        if (!sigName || !agreed) { toast('Please sign the document first.', 'error'); return; }

        var hasCounterparty = $('toggle-counterparty').checked;

        showLoading('Uploading document...');
        var fd = new FormData();
        fd.append('pdf', state.uploadedFile);
        fd.append('title', $('input-title').value.trim());
        fd.append('category', $('input-category').value);
        fd.append('creator_email', $('input-creator-email').value.trim());
        fd.append('note', $('input-note').value.trim());
        fd.append('is_public', $('input-is-public').checked ? 'true' : 'false');
        fd.append('title_public', $('input-title-public').checked ? 'true' : 'false');

        if (hasCounterparty) {
            fd.append('counterparty_email', $('input-email').value.trim());
        }

        api('/documents', { method: 'POST', body: fd }).then(function(d) {
            state.pendingDocUuid = d.doc_uuid;
            state.pendingSig = { name: sigName, agreed: agreed };

            // Show payment
            hideLoading();
            hide('btn-create-submit');
            hide('wiz-nav-3');
            show('payment-section');
            $('pay-fee-amount').textContent = state.feeKas;

            toast('Document uploaded. Pay to complete signing.', 'info');
        }).catch(function(e) { hideLoading(); toast(e.message, 'error'); });
    }

    function payFee() {
        if (!state.pendingDocUuid || !window.KasperoPay) {
            toast('Payment widget not ready.', 'error');
            return;
        }

        window.KasperoPay.onPayment(function(payment) {
            if (state.pendingDocUuid && payment.txid) {
                verifyAndRecordPayment(state.pendingDocUuid, payment.payment_id, payment.txid, payment.amount_kas || state.feeKas);
            }
        });

        window.KasperoPay.pay({
            amount: state.feeKas,
            item: 'Notary Fee - ' + ($('input-title').value.trim() || 'Document'),
            showReceipt: false,
            onCancel: function() { toast('Payment cancelled.', 'info'); }
        });
    }

    function verifyAndRecordPayment(docUuid, paymentId, txid, amountKas) {
        showLoading('Verifying payment...');

        api('/documents/' + docUuid + '/payment', {
            method: 'POST',
            body: JSON.stringify({ tx_id: txid, payment_id: paymentId, amount_kas: amountKas })
        }).then(function() {
            if (state.pendingSig) {
                $('loading-text').textContent = 'Signing document...';
                return api('/documents/' + docUuid + '/sign', {
                    method: 'POST',
                    body: JSON.stringify({
                        signature: { type: 'typed', value: state.pendingSig.name },
                        agreed: true,
                        skip_invite_email: true
                    })
                });
            }
            return null;
        }).then(function(signResult) {
            hideLoading();
            state.pendingSig = null;

            // Move to Step 4: Complete
            showWizardStep(4);

            if (signResult && signResult.single_signer && signResult.status === 'notarized') {
                // Single-signer - sealed immediately
                show('complete-single');
                hide('complete-two-party');
                $('btn-view-sealed').onclick = function() {
                    history.pushState(null, '', '/proof/' + docUuid);
                    loadProof(docUuid);
                };
                toast('Document sealed on the blockchain!', 'success');
            } else if (signResult && signResult.invite_url) {
                // Two-party - waiting for counterparty
                state.pendingInviteUrl = signResult.invite_url;
                hide('complete-single');
                show('complete-two-party');
                $('create-invite-status').textContent = '';
                $('btn-goto-doc').onclick = function() {
                    history.pushState(null, '', '/document/' + docUuid);
                    loadDocument(docUuid);
                };
                toast('Signed! Send the invite to your counterparty.', 'success');
            } else {
                // Fallback - go to document
                state.pendingDocUuid = null;
                toast('Payment confirmed.', 'success');
                history.pushState(null, '', '/document/' + docUuid);
                loadDocument(docUuid);
            }
        }).catch(function(e) {
            hideLoading();
            toast('Error: ' + e.message, 'error');
        });
    }

    // ════════════════════════════════════════════
    // DOCUMENT VIEW
    // ════════════════════════════════════════════

    function loadDocument(uuid) {
        showLoading('Loading...');
        api('/documents/' + uuid).then(function(d) {
            hideLoading();
            state.currentDoc = d.document;
            renderDoc(d.document);
        }).catch(function(e) { hideLoading(); toast(e.message, 'error'); loadDashboard(); });
    }

    function renderDoc(doc) {
        showScreen('screen-document');
        var me = doc.creator_wallet_address === state.walletAddress;
        var isSingle = !doc.counterparty_email;

        $('doc-status-banner').outerHTML = statusBanner(doc.status);
        $('doc-title').textContent = doc.title;

        // Party identity badge
        var meA = state.walletAddress === doc.creator_wallet_address;
        var meB = state.walletAddress === doc.counterparty_wallet_address;
        var partyText = meA ? 'You are Party A (Creator)' : meB ? 'You are Party B (Counterparty)' : '';
        var metaParts = [];
        if (partyText) metaParts.push(partyText);
        if (isSingle) metaParts.push('Single signature');
        metaParts.push('Created ' + formatDate(doc.created_at));
        $('doc-meta').textContent = metaParts.join(' · ');

        $('doc-hash').textContent = 'SHA-256: ' + (doc.original_hash || '').slice(0, 16) + '...';
        $('doc-hash').title = doc.original_hash;
        $('doc-hash').onclick = function() { navigator.clipboard.writeText(doc.original_hash); toast('Hash copied', 'info'); };
        $('doc-file-info').textContent = formatSize(doc.file_size || 0) + ' · PDF';
        $('btn-download-original').onclick = function(e) { e.preventDefault(); window.open(API + '/documents/' + doc.doc_uuid + '/pdf', '_blank'); };

        renderPdf(API + '/documents/' + doc.doc_uuid + '/pdf', 'pdf-canvas');

        // Signatures
        if (isSingle) {
            $('sig-rows').innerHTML = sigRow('Signer', doc.creator_wallet_address, doc.creator_signature, doc.creator_signed_at);
        } else {
            $('sig-rows').innerHTML =
                sigRow('Creator (Party A)', doc.creator_wallet_address, doc.creator_signature, doc.creator_signed_at) +
                sigRow('Counterparty (Party B)', doc.counterparty_wallet_address, doc.counterparty_signature, doc.counterparty_signed_at, doc.counterparty_email);
        }
        show('signatures-section');

        // Hide all action sections
        hide('sign-action'); hide('invite-action'); hide('finalize-action');
        hide('chain-proof'); hide('notary-seal'); hide('download-section');
        hide('draft-actions'); hide('draft-edit-form');

        // Draft - show edit/pay/delete
        if (me && doc.status === 'draft') {
            show('draft-actions');
            if ($('draft-pay-amount')) $('draft-pay-amount').textContent = state.feeKas;
        }

        // Paid - show sign form
        if (me && doc.status === 'paid' && !doc.creator_signature) {
            show('sign-action');
            $('btn-sign').disabled = true;
            $('input-sig-name').value = '';
            $('input-agree').checked = false;
        }

        // Pending cosign - show invite status (two-party only)
        if (me && doc.status === 'pending_cosign' && !isSingle) {
            show('invite-action');
            $('invite-status').textContent = doc.invite_sent_at ? 'Invitation sent to ' + doc.counterparty_email + ' on ' + formatDate(doc.invite_sent_at) : 'Invitation being sent...';
            $('btn-send-invite').textContent = 'Resend Invitation';
        }

        // Pending finalization - seal failed, show retry
        if (me && doc.status === 'pending_finalization') show('finalize-action');

        // Notarized
        if (doc.status === 'notarized') {
            show('chain-proof'); show('notary-seal'); show('download-section');
            renderProof(doc);
        }
    }

    function sigRow(label, addr, sig, at, email) {
        var ok = !!sig;
        var c = ok ? 'signed' : 'waiting';
        var ic = ok ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>';
        var a = ok ? truncAddr((sig && sig.wallet_address) || addr) : (email ? 'Awaiting ' + email : 'Awaiting...');
        var t = ok && at ? '<div class="sig-time">Signed ' + formatDate(at) + '</div>' : '';
        return '<div class="signature-row"><div class="sig-indicator ' + c + '">' + ic + '</div><div class="sig-info"><div class="sig-label">' + esc(label) + '</div><div class="sig-address">' + esc(a) + '</div>' + t + '</div></div>';
    }

    function renderProof(doc) {
        var r = $('proof-rows');
        if (!r) return;
        r.innerHTML = '';
        function row(l, v, link, mono) {
            var cls = mono ? ' mono' : '';
            var val = link && v ? '<a href="' + EXPLORER + v + '" target="_blank" class="mono">' + v.slice(0, 20) + '...</a>' : (v ? '<span class="' + cls + '">' + esc(v) + '</span>' : '-');
            return '<div class="proof-row"><span class="proof-label">' + l + '</span><span class="proof-value">' + val + '</span></div>';
        }
        r.innerHTML =
            row('Seal Transaction', doc.seal_tx_id, true) +
            row('Document Hash', doc.original_hash, false, true) +
            row('Party A', doc.creator_wallet_address ? truncAddr(doc.creator_wallet_address) : null) +
            (doc.counterparty_wallet_address ? row('Party B', truncAddr(doc.counterparty_wallet_address)) : '') +
            row('Sealed', formatDate(doc.notarized_at));
        if ($('seal-date')) $('seal-date').textContent = formatDateShort(doc.notarized_at);
    }

    // ════════════════════════════════════════════
    // DOCUMENT VIEW - Actions
    // ════════════════════════════════════════════

    function checkSignReady() {
        $('btn-sign').disabled = !($('input-sig-name').value.trim() && $('input-agree').checked);
    }

    function signDoc() {
        var n = $('input-sig-name').value.trim();
        var agreed = $('input-agree').checked;
        if (!n || !agreed || !state.currentDoc) return;
        showLoading('Signing...');
        api('/documents/' + state.currentDoc.doc_uuid + '/sign', { method: 'POST', body: JSON.stringify({ signature: { type: 'typed', value: n }, agreed: true }) }).then(function(d) {
            hideLoading();
            toast('Document signed.', 'success');
            loadDocument(state.currentDoc.doc_uuid);
        }).catch(function(e) { hideLoading(); toast('Signing failed: ' + e.message, 'error'); });
    }

    function sendInvite() {
        if (!state.currentDoc) return;
        showLoading('Sending...');
        api('/documents/' + state.currentDoc.doc_uuid + '/invite', { method: 'POST', body: JSON.stringify({}) }).then(function(d) {
            hideLoading();
            toast('Invitation sent to ' + state.currentDoc.counterparty_email, 'success');
            $('invite-status').textContent = 'Sent. Link: ' + (d.invite_url || '');
            $('btn-send-invite').textContent = 'Resend Invitation';
        }).catch(function(e) { hideLoading(); toast(e.message, 'error'); });
    }

    function finalize() {
        if (!state.currentDoc) return;
        showLoading('Sealing on blockchain...');
        api('/documents/' + state.currentDoc.doc_uuid + '/finalize', { method: 'POST', body: JSON.stringify({}) }).then(function() {
            hideLoading();
            toast('Notarized on Kaspa blockchain.', 'success');
            loadDocument(state.currentDoc.doc_uuid);
        }).catch(function(e) { hideLoading(); toast(e.message, 'error'); });
    }

    // ════════════════════════════════════════════
    // INVITE FLOW (counterparty)
    // ════════════════════════════════════════════

    function loadInvite(token) {
        state.inviteToken = token;
        showLoading('Loading...');
        api('/invite/' + token).then(function(d) {
            hideLoading();
            state.inviteDoc = d.document;
            renderInvite(d.document);
        }).catch(function(e) { hideLoading(); toast(e.message, 'error'); loadArchive(); });
    }

    function renderInvite(doc) {
        showScreen('screen-invite');

        $('invite-desc').textContent = truncAddr(doc.creator_wallet_address) + ' invited you to sign this agreement.';

        var isNotarized = doc.status === 'notarized';
        var pending = doc.status === 'pending_cosign';
        var statusText = pending ? 'Awaiting your signature' : (isNotarized ? 'Document sealed on the Kaspa blockchain' : 'Both parties have signed');
        $('invite-status-banner').className = 'status-banner ' + (pending ? 'pending' : 'confirmed');
        $('invite-status-banner').textContent = statusText;

        $('invite-doc-title').textContent = doc.title;
        $('invite-doc-hash').textContent = 'SHA-256: ' + (doc.original_hash || '').slice(0, 16) + '...';
        $('invite-file-info').textContent = formatSize(doc.file_size || 0) + ' · PDF';
        renderPdf(API + '/invite/' + state.inviteToken + '/pdf', 'invite-pdf-canvas');

        $('invite-sig-rows').innerHTML =
            sigRow('Creator (Party A)', doc.creator_wallet_address, doc.creator_signature, doc.creator_signed_at) +
            sigRow('Counterparty (Party B)', doc.counterparty_wallet_address, doc.counterparty_signature, doc.counterparty_signed_at, doc.counterparty_email);

        // Show which party the connected user is
        if (state.walletAddress) {
            var isCreator = state.walletAddress === doc.creator_wallet_address;
            var isCounter = state.walletAddress === doc.counterparty_wallet_address;
            if (isCreator || isCounter) {
                var partyLabel = isCreator ? 'You are Party A (Creator)' : 'You are Party B (Counterparty)';
                var existing = document.getElementById('invite-party-badge');
                if (!existing) {
                    var badge = document.createElement('div');
                    badge.id = 'invite-party-badge';
                    badge.className = 'status-banner info';
                    badge.textContent = partyLabel;
                    $('invite-status-banner').parentNode.insertBefore(badge, $('invite-status-banner').nextSibling);
                } else {
                    existing.textContent = partyLabel;
                }
            }
        }

        // Seal TX link (when notarized)
        var existingTx = document.getElementById('invite-seal-tx');
        if (existingTx) existingTx.remove();
        if (isNotarized && doc.seal_tx_id) {
            var txDiv = document.createElement('div');
            txDiv.id = 'invite-seal-tx';
            txDiv.className = 'chain-proof';
            txDiv.innerHTML = '<div class="chain-proof-header"><h3>Blockchain Proof</h3><div class="verified-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20,6 9,17 4,12"/></svg>Verified</div></div>' +
                '<div class="proof-rows">' +
                '<div class="proof-row"><span class="proof-label">Seal Transaction</span><span class="proof-value"><a href="' + EXPLORER + doc.seal_tx_id + '" target="_blank" class="mono">' + doc.seal_tx_id.slice(0, 20) + '...</a></span></div>' +
                '<div class="proof-row"><span class="proof-label">Document Hash</span><span class="proof-value mono" style="font-size:11px;word-break:break-all;">' + esc(doc.original_hash) + '</span></div>' +
                '<div class="proof-row"><span class="proof-label">Sealed</span><span class="proof-value">' + formatDate(doc.notarized_at) + '</span></div>' +
                '</div>';
            $('invite-sig-rows').parentNode.parentNode.insertBefore(txDiv, $('invite-already-signed'));
        }

        // Show/hide email field
        if (doc.counterparty_email) { hide('invite-email-group'); } else { show('invite-email-group'); }

        if (pending) {
            show('invite-sign-action'); hide('invite-already-signed'); hide('invite-sig-form');
            show('btn-invite-connect');
            $('invite-sig-name').value = '';
            $('btn-invite-sign').disabled = true;
        } else {
            hide('invite-sign-action'); show('invite-already-signed');
        }
    }

    function inviteConnect() {
        connectWallet().then(function(ok) {
            if (ok) { show('invite-sig-form'); hide('btn-invite-connect'); toast('Connected: ' + truncAddr(state.walletAddress), 'success'); }
        });
    }

    function checkInviteSignReady() {
        var name = $('invite-sig-name').value.trim();
        var agreed = $('invite-agree').checked;
        var emailEl = $('invite-email');
        var emailNeeded = emailEl && !emailEl.closest('.hidden');
        var emailOk = emailNeeded ? (emailEl.value.trim() && emailEl.value.trim().includes('@')) : true;
        $('btn-invite-sign').disabled = !(name && agreed && emailOk);
    }

    function inviteSign() {
        var n = $('invite-sig-name').value.trim();
        var agreed = $('invite-agree').checked;
        if (!n || !agreed || !state.inviteDoc) return;
        var email = $('invite-email').value.trim();
        showLoading('Signing and sealing...');
        api('/documents/' + state.inviteDoc.doc_uuid + '/sign', {
            method: 'POST',
            body: JSON.stringify({
                signature: { type: 'typed', value: n },
                agreed: true,
                email: email || undefined
            })
        }).then(function(d) {
            hideLoading();
            if (d.status === 'notarized') {
                toast('Document signed and sealed on blockchain!', 'success');
            } else {
                toast('Document signed.', 'success');
            }
            loadInvite(state.inviteToken);
        }).catch(function(e) { hideLoading(); toast(e.message, 'error'); });
    }

    // ════════════════════════════════════════════
    // PUBLIC PROOF PAGE
    // ════════════════════════════════════════════

    function loadProof(uuid) {
        showLoading('Loading proof...');
        api('/proof/' + uuid).then(function(d) {
            hideLoading();
            var p = d.proof;
            renderProofPage(p, uuid);
        }).catch(function(e) { hideLoading(); toast(e.message, 'error'); loadArchive(); });
    }

    function renderProofPage(proof, uuid) {
        showScreen('screen-proof');
        var isSigner = state.walletAddress && (state.walletAddress === proof.party_a || state.walletAddress === proof.party_b);
        var isSingle = !proof.party_b;

        // Title
        if (proof.title) {
            $('proof-title').textContent = proof.title;
            $('proof-title').className = 'proof-title';
        } else {
            $('proof-title').textContent = 'Private Document';
            $('proof-title').className = 'proof-title private';
        }

        // Category
        $('proof-category').textContent = categoryLabel(proof.category);

        // Details
        $('proof-hash').textContent = proof.document_hash;
        $('proof-hash').title = proof.document_hash;
        $('proof-hash').style.cursor = 'pointer';
        $('proof-hash').onclick = function() { navigator.clipboard.writeText(proof.document_hash); toast('Hash copied', 'info'); };

        $('proof-date').textContent = formatDate(proof.notarized_at);
        $('proof-party-a').textContent = proof.party_a;

        if (isSingle) {
            hide('proof-party-b-row');
            hide('proof-party-b-signed-row');
        } else {
            show('proof-party-b-row');
            show('proof-party-b-signed-row');
            $('proof-party-b').textContent = proof.party_b;
            $('proof-party-b-signed').textContent = formatDate(proof.party_b_signed);
        }

        $('proof-party-a-signed').textContent = formatDate(proof.party_a_signed);

        // Seal date on the notary stamp
        if ($('proof-seal-date')) $('proof-seal-date').textContent = formatDateShort(proof.notarized_at);

        // Seal TX link
        if (proof.seal_tx_id) {
            $('proof-tx').innerHTML = '<a href="' + EXPLORER + proof.seal_tx_id + '" target="_blank" class="mono">' + proof.seal_tx_id + '</a>';
        } else {
            $('proof-tx').textContent = '-';
        }

        // Public PDF viewer
        if (proof.is_public) {
            show('proof-document');
            if ($('btn-proof-view-pdf')) {
                $('btn-proof-view-pdf').href = API + '/archive/' + uuid + '/pdf';
            }
            renderPdf(API + '/archive/' + uuid + '/pdf', 'proof-pdf-canvas');
        } else {
            hide('proof-document');
        }

        // Signer-only note
        if (isSigner) {
            show('proof-signer-note');
            $('proof-access-msg').textContent = 'You are a signer on this document. You can view the full document from your dashboard.';
        } else if (!proof.is_public) {
            show('proof-signer-note');
            $('proof-access-msg').textContent = state.walletAddress
                ? 'Document visible only to the original signers.'
                : 'Connect your wallet to view the document (signers only).';
        } else {
            hide('proof-signer-note');
        }

        // Verify tool
        initVerifyTool(proof.document_hash);
    }

    function initVerifyTool(expectedHash) {
        var zone = $('verify-upload-zone');
        if (!zone) return;

        // Reset
        hide('verify-result');

        zone.onclick = function() { $('verify-file-input').click(); };
        $('verify-file-input').onchange = function(e) { if (e.target.files[0]) verifyFile(e.target.files[0], expectedHash); };
        zone.ondragover = function(e) { e.preventDefault(); zone.classList.add('drag-over'); };
        zone.ondragleave = function() { zone.classList.remove('drag-over'); };
        zone.ondrop = function(e) { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) verifyFile(e.dataTransfer.files[0], expectedHash); };
    }

    function verifyFile(file, expectedHash) {
        file.arrayBuffer().then(sha256).then(function(h) {
            var match = h === expectedHash;
            var result = $('verify-result');
            show(result);
            if (match) {
                result.className = 'verify-result verify-match';
                result.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>' +
                    '<div><strong>Match confirmed.</strong> This file is identical to the sealed document.</div>';
            } else {
                result.className = 'verify-result verify-mismatch';
                result.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' +
                    '<div><strong>No match.</strong> This file does not match the sealed document. Hash: <span class="mono" style="font-size:11px;word-break:break-all;">' + h + '</span></div>';
            }
        });
    }

    // ── PDF Fullscreen ──
    function openPdfFullscreen(viewerId, title) {
        var viewer = $(viewerId);
        if (!viewer) return;
        var canvases = viewer.querySelectorAll('canvas');
        if (!canvases.length) return;

        var overlay = document.createElement('div');
        overlay.className = 'pdf-fullscreen-overlay';
        overlay.innerHTML = '<div class="pdf-fullscreen-header"><h3>' + esc(title || 'Document') + '</h3><button class="pdf-fullscreen-close" id="pdf-fs-close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="pdf-fullscreen-body" id="pdf-fs-body"></div>';
        document.body.appendChild(overlay);

        var body = document.getElementById('pdf-fs-body');
        canvases.forEach(function(c) {
            var clone = document.createElement('canvas');
            clone.width = c.width;
            clone.height = c.height;
            clone.getContext('2d').drawImage(c, 0, 0);
            body.appendChild(clone);
        });

        document.getElementById('pdf-fs-close').onclick = function() { overlay.remove(); };
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
        document.addEventListener('keydown', function handler(e) {
            if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
        });
    }

    // ════════════════════════════════════════════
    // ROUTING
    // ════════════════════════════════════════════

    function route() {
        var p = window.location.pathname;
        var inv = p.match(/^\/invite\/([a-f0-9]+)$/);
        if (inv) { loadInvite(inv[1]); return; }
        var prf = p.match(/^\/proof\/([a-f0-9-]+)$/);
        if (prf) { loadProof(prf[1]); return; }
        var doc = p.match(/^\/document\/([a-f0-9-]+)$/);
        if (doc && state.token) { loadDocument(doc[1]); return; }
        if (state.token && state.walletAddress) loadDashboard(); else loadArchive();
    }

    // ════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════

    function init() {
        updateHeader();
        api('/config').then(function(d) { state.feeKas = d.fee_kas || 5; state.merchantId = d.merchant_id; }).catch(function() {});

        // ── Nav ──
        $('btn-home').onclick = function() { history.pushState(null, '', '/'); if (state.token) loadDashboard(); else loadArchive(); };
        $('nav-archive').onclick = function() { history.pushState(null, '', '/'); loadArchive(); };
        $('nav-my-docs').onclick = function() { history.pushState(null, '', '/'); loadDashboard(); };
        $('nav-new-doc').onclick = function() { showCreate(); };
        $('nav-how').onclick = function() { showScreen('screen-how'); setActiveNav('nav-how'); };
        $('nav-hash').onclick = function() { showScreen('screen-hash'); setActiveNav('nav-hash'); };

        // ── Header ──
        $('btn-connect').onclick = function() { connectWallet().then(function(ok) { if (ok) loadDashboard(); }); };
        $('btn-disconnect').onclick = disconnect;

        // ── Dashboard ──
        $('btn-new-doc').onclick = showCreate;

        // ── Archive search/filter ──
        var archiveDebounce = null;
        if ($('archive-search-input')) {
            $('archive-search-input').oninput = function() {
                clearTimeout(archiveDebounce);
                archiveDebounce = setTimeout(function() { state.archivePage = 1; fetchArchive(); }, 300);
            };
        }
        if ($('archive-filter-category')) $('archive-filter-category').onchange = function() { state.archivePage = 1; fetchArchive(); };
        if ($('archive-filter-period')) $('archive-filter-period').onchange = function() { state.archivePage = 1; fetchArchive(); };
        if ($('archive-prev')) $('archive-prev').onclick = function() { if (state.archivePage > 1) { state.archivePage--; fetchArchive(); } };
        if ($('archive-next')) $('archive-next').onclick = function() { state.archivePage++; fetchArchive(); };

        // ── Hash tool ──
        initHashTool();

        // ── Create wizard: Step 1 ──
        $('input-title').oninput = checkStep1;

        var uz = $('upload-zone');
        uz.onclick = function() { $('file-input').click(); };
        $('file-input').onchange = function(e) { if (e.target.files[0]) pickFile(e.target.files[0]); };
        uz.ondragover = function(e) { e.preventDefault(); uz.classList.add('drag-over'); };
        uz.ondragleave = function() { uz.classList.remove('drag-over'); };
        uz.ondrop = function(e) { e.preventDefault(); uz.classList.remove('drag-over'); if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); };
        $('btn-file-remove').onclick = function() { state.uploadedFile = null; state.uploadedHash = null; $('file-input').value = ''; show('upload-zone'); hide('file-preview'); checkStep1(); };

        $('btn-wiz-next-1').onclick = function() {
            if (!$('input-title').value.trim() || !state.uploadedFile) return;
            showWizardStep(2);
        };

        // ── Create wizard: Step 2 ──
        $('toggle-counterparty').onchange = function() {
            if (this.checked) { show('party-b-section'); } else { hide('party-b-section'); $('input-email').value = ''; }
            updatePartySummary();
        };

        $('btn-wiz-back-2').onclick = function() { showWizardStep(1); };
        $('btn-wiz-next-2').onclick = function() {
            if (!checkStep2()) {
                toast('Please fill in all required email fields.', 'error');
                return;
            }

            // Build sign summary
            var summary = '<div class="sign-summary-item"><strong>' + esc($('input-title').value.trim()) + '</strong></div>';
            summary += '<div class="sign-summary-item">' + categoryLabel($('input-category').value) + ' · ' + esc(state.uploadedFile.name) + ' · ' + formatSize(state.uploadedFile.size) + '</div>';
            if ($('toggle-counterparty').checked) {
                summary += '<div class="sign-summary-item">Counterparty: ' + esc($('input-email').value.trim()) + '</div>';
            } else {
                summary += '<div class="sign-summary-item">Single-signature document</div>';
            }
            $('sign-summary').innerHTML = summary;

            showWizardStep(3);
        };

        // ── Create wizard: Step 3 ──
        $('create-sig-name').oninput = checkStep3;
        $('create-agree').onchange = checkStep3;
        $('btn-create-submit').onclick = submitCreate;
        $('btn-pay-fee').onclick = payFee;
        $('btn-wiz-back-3').onclick = function() { showWizardStep(2); };

        // ── Create wizard: Step 4 ──
        if ($('btn-send-invite-create')) $('btn-send-invite-create').onclick = function() {
            if (!state.pendingDocUuid) return;
            showLoading('Sending invite...');
            api('/documents/' + state.pendingDocUuid + '/invite', { method: 'POST', body: JSON.stringify({}) }).then(function(d) {
                hideLoading();
                toast('Invitation sent!', 'success');
                $('create-invite-status').textContent = 'Invite sent. You can also copy the link below.';
                if (d.invite_url) state.pendingInviteUrl = d.invite_url;
            }).catch(function(e) { hideLoading(); toast(e.message, 'error'); });
        };

        if ($('btn-copy-link-create')) $('btn-copy-link-create').onclick = function() {
            if (state.pendingInviteUrl) {
                navigator.clipboard.writeText(state.pendingInviteUrl);
                toast('Invite link copied!', 'info');
                $('create-invite-status').textContent = state.pendingInviteUrl;
            }
        };

        // ── Document view ──
        $('btn-back-dash').onclick = function() { history.pushState(null, '', '/'); loadDashboard(); };
        $('btn-back-dash2').onclick = function() { history.pushState(null, '', '/'); loadDashboard(); };
        $('input-sig-name').oninput = checkSignReady;
        $('input-agree').onchange = checkSignReady;
        $('btn-sign').onclick = signDoc;
        $('btn-send-invite').onclick = sendInvite;
        $('btn-finalize').onclick = finalize;
        $('btn-download-signed').onclick = function() { if (state.currentDoc) window.open(API + '/documents/' + state.currentDoc.doc_uuid + '/download', '_blank'); };

        // PDF fullscreen
        if ($('btn-pdf-fullscreen')) $('btn-pdf-fullscreen').onclick = function() { openPdfFullscreen('pdf-viewer', state.currentDoc ? state.currentDoc.title : 'Document'); };
        if ($('btn-invite-pdf-fullscreen')) $('btn-invite-pdf-fullscreen').onclick = function() { openPdfFullscreen('invite-pdf-viewer', state.inviteDoc ? state.inviteDoc.title : 'Document'); };

        // ── Draft actions ──
        if ($('btn-draft-pay')) $('btn-draft-pay').onclick = function() {
            if (!state.currentDoc || !window.KasperoPay) { toast('Payment widget not ready.', 'error'); return; }
            state.pendingDocUuid = state.currentDoc.doc_uuid;
            window.KasperoPay.onPayment(function(payment) {
                if (state.pendingDocUuid && payment.txid) {
                    verifyAndRecordPayment(state.pendingDocUuid, payment.payment_id, payment.txid, payment.amount_kas || state.feeKas);
                }
            });
            window.KasperoPay.pay({
                amount: state.feeKas,
                item: 'Notary Fee - ' + (state.currentDoc.title || 'Document'),
                showReceipt: false,
                onCancel: function() { toast('Payment cancelled.', 'info'); }
            });
        };

        if ($('btn-draft-edit')) $('btn-draft-edit').onclick = function() {
            if (!state.currentDoc) return;
            var doc = state.currentDoc;
            $('edit-title').value = doc.title || '';
            $('edit-email').value = doc.counterparty_email || '';
            $('edit-note').value = doc.note || '';
            if ($('edit-file')) $('edit-file').value = '';
            hide('draft-actions');
            show('draft-edit-form');
        };

        if ($('btn-draft-cancel')) $('btn-draft-cancel').onclick = function() {
            hide('draft-edit-form');
            show('draft-actions');
        };

        if ($('btn-draft-save')) $('btn-draft-save').onclick = function() {
            if (!state.currentDoc) return;
            var fileInput = $('edit-file');
            var fd = new FormData();
            fd.append('title', $('edit-title').value.trim());
            fd.append('counterparty_email', $('edit-email').value.trim());
            fd.append('note', $('edit-note').value.trim());
            if (fileInput && fileInput.files[0]) {
                fd.append('pdf', fileInput.files[0]);
            }
            showLoading('Saving...');
            fetch(API + '/documents/' + state.currentDoc.doc_uuid, {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + state.token },
                body: fd
            }).then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error); return d; }); })
                .then(function() {
                    hideLoading();
                    toast('Draft updated.', 'success');
                    loadDocument(state.currentDoc.doc_uuid);
                }).catch(function(e) { hideLoading(); toast(e.message, 'error'); });
        };

        if ($('btn-draft-delete')) $('btn-draft-delete').onclick = function() {
            if (!state.currentDoc) return;
            if (!confirm('Delete this draft? This cannot be undone.')) return;
            showLoading('Deleting...');
            api('/documents/' + state.currentDoc.doc_uuid, { method: 'DELETE' }).then(function() {
                hideLoading();
                toast('Draft deleted.', 'success');
                history.pushState(null, '', '/');
                loadDashboard();
            }).catch(function(e) { hideLoading(); toast(e.message, 'error'); });
        };

        // ── Invite view ──
        $('btn-invite-connect').onclick = inviteConnect;
        $('invite-sig-name').oninput = checkInviteSignReady;
        $('invite-agree').onchange = checkInviteSignReady;
        if ($('invite-email')) $('invite-email').oninput = checkInviteSignReady;
        $('btn-invite-sign').onclick = inviteSign;

        // ── Routing ──
        window.onpopstate = route;
        route();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
