(function() {
    'use strict';

    var state = {
        token: localStorage.getItem('notary_token') || null,
        walletAddress: localStorage.getItem('notary_wallet') || null,
		userEmail: localStorage.getItem('notary_email') || null,
        currentDoc: null, inviteToken: null, inviteDoc: null,
        uploadedFile: null, uploadedHash: null,
        feeKas: 5, merchantId: null, signatureFields: []
    };

    var API = '/api';
    var EXPLORER = 'https://explorer.kaspa.org/txs/';

    function $(id) { return document.getElementById(id); }
    function show(el) { if (typeof el === 'string') el = $(el); if (el) el.classList.remove('hidden'); }
    function hide(el) { if (typeof el === 'string') el = $(el); if (el) el.classList.add('hidden'); }
    function showScreen(id) { document.querySelectorAll('.screen').forEach(function(s) { s.classList.add('hidden'); }); show(id); window.scrollTo(0,0); }
    function showLoading(t) { $('loading-text').textContent = t || 'Processing...'; show('loading'); }
    function hideLoading() { hide('loading'); }

    function toast(msg, type) {
        var t = $('toast'); t.textContent = msg; t.className = 'toast ' + (type || 'info');
        show(t); setTimeout(function() { hide(t); }, 4000);
    }

    function truncAddr(a) { return a ? a.slice(0,14) + '...' + a.slice(-6) : ''; }
    function formatDate(d) { if (!d) return ''; var o = new Date(d); return o.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + ' at ' + o.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); }
    function formatDateShort(d) { return d ? new Date(d).toISOString().slice(0,10) : ''; }
    function formatSize(b) { if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(0)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
    function sha256(buf) { return crypto.subtle.digest('SHA-256',buf).then(function(h) { return Array.from(new Uint8Array(h)).map(function(b){return b.toString(16).padStart(2,'0');}).join(''); }); }
    function esc(s) { var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

    function statusLabel(s) {
        return {draft:'Draft',paid:'Paid — Ready to Sign',pending_cosign:'Awaiting Countersignature',pending_finalization:'Ready to Finalize',notarized:'Notarized',expired:'Expired',cancelled:'Cancelled'}[s]||s;
    }

    function statusBanner(s) {
        var c = s==='notarized'?'confirmed':(s==='pending_cosign'||s==='pending_finalization')?'pending':s==='paid'?'paid':'draft';
        var icons = {
            draft:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
            paid:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
            pending:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>',
            confirmed:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>'
        };
        return '<div class="status-banner '+c+'" id="doc-status-banner">'+icons[c]+' '+statusLabel(s)+'</div>';
    }

	function api(ep, opts) {
        opts = opts || {};
        var h = opts.headers || {};
        if (state.token && !h['Authorization']) h['Authorization'] = 'Bearer ' + state.token;
        if (!(opts.body instanceof FormData) && !h['Content-Type']) h['Content-Type'] = 'application/json';
        return fetch(API+ep, {method:opts.method||'GET', headers:h, body:opts.body}).then(function(r) {
            if (r.status === 401) { disconnect(); throw new Error('Session expired'); }
            return r.json().then(function(d) { if (!r.ok) throw new Error(d.error||'Request failed'); return d; });
        });
    }

    // ── PDF ──
    function renderPdf(url, canvasId) {
        if (!window.pdfjsLib) return Promise.resolve();
        var h = {}; if (state.token) h['Authorization'] = 'Bearer ' + state.token;
        var canvas = $(canvasId);
        var container = canvas.parentElement;

        return fetch(url,{headers:h}).then(function(r){return r.arrayBuffer();}).then(function(d) {
            return pdfjsLib.getDocument({data:d}).promise;
        }).then(function(pdf) {
            // Clear container, keep first canvas for page 1
            var extras = container.querySelectorAll('.pdf-page-extra');
            extras.forEach(function(e){e.remove();});

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
                    var uv = page.getViewport({scale:1});
                    var sc = cw / uv.width;
                    var vp = page.getViewport({scale:sc});
                    c.width = vp.width;
                    c.height = vp.height;
                    return page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
                });
            };

            var chain = Promise.resolve();
            for (var i = 1; i <= pdf.numPages; i++) {
                (function(n) {
                    chain = chain.then(function() { return renderPage(n); });
                })(i);
            }
            return chain;
        }).catch(function(e){console.error('PDF render:',e);});
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
                if (!addr) { toast('No Kaspa wallet detected. Install KasWare, Kastle, or Keystone extension.','error'); resolve(false); return; }
                finishAuth(addr).then(resolve);
            }).catch(function(e) { toast('Wallet error: '+e.message,'error'); resolve(false); });
        });
    }

    function detectWallet() {
        if (window.kasware) return window.kasware.requestAccounts().then(function(a){return a[0];});
        if (window.kastle) return window.kastle.connect('mainnet').then(function(){return window.kastle.getAccount();}).then(function(a){return a.address;});
        if (window.keystone) return window.keystone.requestAccounts().then(function(a){return Array.isArray(a)?a[0]:a;});
        return Promise.resolve(null);
    }

	function finishAuth(address) {
        return api('/auth/connect',{method:'POST',body:JSON.stringify({address:address})}).then(function(d) {
            state.token=d.token; state.walletAddress=d.address; state.userEmail=d.email||null;
            localStorage.setItem('notary_token',d.token); localStorage.setItem('notary_wallet',d.address);
            if (d.email) localStorage.setItem('notary_email',d.email);
            updateHeader(); return true;
        }).catch(function(e) { toast('Auth failed: '+e.message,'error'); return false; });
    }

	function disconnect() {
        state.token=null; state.walletAddress=null; state.userEmail=null;
        localStorage.removeItem('notary_token'); localStorage.removeItem('notary_wallet'); localStorage.removeItem('notary_email');
        localStorage.removeItem('notary_token'); localStorage.removeItem('notary_wallet');
        if (window.KasperoPay && KasperoPay.disconnect) KasperoPay.disconnect();
        updateHeader(); loadArchive();
    }
	
	function updateHeader() {
        if (state.walletAddress) {
            $('header-wallet-addr').textContent=truncAddr(state.walletAddress);
            show('header-wallet'); hide('btn-connect');
            show('nav-my-docs'); show('nav-new-doc');
        } else {
            hide('header-wallet'); show('btn-connect');
            hide('nav-my-docs'); hide('nav-new-doc');
        }
    }

    function setActiveNav(id) {
        document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
        if ($(id)) $(id).classList.add('active');
    }

    function loadDashboard() {
        showScreen('screen-dashboard'); setActiveNav('nav-my-docs');
        api('/documents').then(function(d) {
            var list = $('dash-list'); list.innerHTML = '';
            if (!d.documents.length) {
                list.innerHTML='<div class="dash-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg><p>No documents yet</p><p class="small">Create your first notarized agreement.</p></div>';
                return;
            }
            d.documents.forEach(function(doc) {
                var el = document.createElement('div'); el.className='dash-item';
                el.onclick=function(){history.pushState(null,'','/document/'+doc.doc_uuid);loadDocument(doc.doc_uuid);};
                el.innerHTML='<div class="dash-item-left"><div class="dash-item-title">'+esc(doc.title)+'</div><div class="dash-item-meta">'+esc(doc.counterparty_email)+' · '+formatDate(doc.created_at)+'</div></div><span class="status-pill '+doc.status+'">'+statusLabel(doc.status)+'</span>';
                list.appendChild(el);
            });
        }).catch(function(e){toast(e.message,'error');});
    }

	// ── Create (unified: upload + sign + pay) ──
    function showCreate() {
        showScreen('screen-create'); setActiveNav('nav-new-doc'); state.uploadedFile=null; state.uploadedHash=null;
		$('input-title').value=''; $('input-email').value=''; $('input-note').value='';
        $('input-creator-email').value = state.userEmail || '';
        $('create-sig-name').value=''; $('create-agree').checked=false;
        if ($('input-is-public')) $('input-is-public').checked=false;
        if ($('input-title-public')) $('input-title-public').checked=true;
        hide('file-preview'); show('upload-zone'); $('btn-create-submit').disabled=true;
        hide('create-step-sign'); hide('payment-section'); hide('create-post-sign');
        $('btn-create-submit').textContent='Upload, Sign & Pay';
        $('cost-fee').textContent=state.feeKas+' KAS';
    }

    function checkCreate() {
        var t=$('input-title').value.trim(), e=$('input-email').value.trim(), ce=$('input-creator-email').value.trim();
        var hasFile = !!state.uploadedFile;
        var hasSig = $('create-sig-name').value.trim() && $('create-agree').checked;
        $('btn-create-submit').disabled=!(t && e && e.includes('@') && ce && ce.includes('@') && hasFile && hasSig);
    }

	function pickFile(file) {
        if (!file) return;
        if (file.type!=='application/pdf') { toast('Only PDF files.','error'); return; }
        if (file.size>10485760) { toast('Max 10 MB.','error'); return; }
        state.uploadedFile=file;
        file.arrayBuffer().then(sha256).then(function(h) {
            state.uploadedHash=h;
            $('preview-name').textContent=file.name;
            $('preview-meta').textContent=formatSize(file.size)+' — SHA-256: '+h.slice(0,12)+'...';
            hide('upload-zone'); show('file-preview');
            show('create-step-sign');
            checkCreate();
        });
    }

	function submitCreate() {
        if (!state.uploadedFile) return;
        var sigName = $('create-sig-name').value.trim();
        var agreed = $('create-agree').checked;
        if (!sigName || !agreed) { toast('Please sign the document first.','error'); return; }

        showLoading('Uploading document...');
        var fd=new FormData();
        fd.append('pdf',state.uploadedFile);
        fd.append('title',$('input-title').value.trim());
        fd.append('counterparty_email',$('input-email').value.trim());
        fd.append('creator_email',$('input-creator-email').value.trim());
        fd.append('note',$('input-note').value.trim());
        fd.append('is_public', $('input-is-public') && $('input-is-public').checked ? 'true' : 'false');
        fd.append('title_public', $('input-title-public') && !$('input-title-public').checked ? 'false' : 'true');

        api('/documents',{method:'POST',body:fd}).then(function(d) {
            state.pendingDocUuid = d.doc_uuid;
            $('loading-text').textContent = 'Paying notary fee...';

            // Immediately show payment
            hideLoading();
            hide('btn-create-submit');
            hide('create-step-details');
            hide('create-step-sign');
            show('payment-section');
            $('pay-fee-amount').textContent = state.feeKas;

            // Store sig data for after payment
            state.pendingSig = { name: sigName, agreed: agreed };

            toast('Document uploaded. Pay to complete signing.', 'info');
        }).catch(function(e){hideLoading();toast(e.message,'error');});
    }

    function payFee() {
        if (!state.pendingDocUuid || !window.KasperoPay) {
            toast('Payment widget not ready.', 'error');
            return;
        }

        // Register callback BEFORE triggering pay
        window.KasperoPay.onPayment(function(payment) {
            if (state.pendingDocUuid && payment.txid) {
                verifyAndRecordPayment(state.pendingDocUuid, payment.payment_id, payment.txid, payment.amount_kas || state.feeKas);
            }
        });

        // Trigger payment with onCancel as an option
        window.KasperoPay.pay({
            amount: state.feeKas,
            item: 'Notary Fee — ' + ($('input-title').value.trim() || 'Document'),
            showReceipt: false,
            onCancel: function() {
                toast('Payment cancelled.', 'info');
            }
        });
    }

	function verifyAndRecordPayment(docUuid, paymentId, txid, amountKas) {
        showLoading('Verifying payment...');

        api('/documents/' + docUuid + '/payment', {
            method: 'POST',
            body: JSON.stringify({
                tx_id: txid,
                payment_id: paymentId,
                amount_kas: amountKas
            })
        }).then(function() {
            // Payment confirmed — now auto-sign if we have pending signature
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

            if (signResult && signResult.invite_url) {
                // Show the invite options inline on the create page
                state.pendingInviteUrl = signResult.invite_url;
                hide('payment-section');
                show('create-post-sign');
                $('create-invite-status').textContent = '';
                toast('Signed! Send the invite to your counterparty.', 'success');
            } else {
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

    function recordPayment(uuid,tx,amt) {
        showLoading('Recording payment...');
        api('/documents/'+uuid+'/payment',{method:'POST',body:JSON.stringify({tx_id:tx,amount_kas:amt})}).then(function() {
            hideLoading(); toast('Payment confirmed.','success');
            history.pushState(null,'','/document/'+uuid); loadDocument(uuid);
        }).catch(function(e){hideLoading();toast(e.message,'error');});
    }

    // ── Document View ──
    function loadDocument(uuid) {
        showLoading('Loading...');
        api('/documents/'+uuid).then(function(d) {
            hideLoading(); state.currentDoc=d.document; renderDoc(d.document);
        }).catch(function(e){hideLoading();toast(e.message,'error');loadDashboard();});
    }

    function renderDoc(doc) {
        showScreen('screen-document');
        var me = doc.creator_wallet_address===state.walletAddress;

        $('doc-status-banner').outerHTML = statusBanner(doc.status);
        $('doc-title').textContent = doc.title;
        $('doc-meta').textContent = 'Created '+formatDate(doc.created_at);

        // Party identity badge
        var meA = state.walletAddress === doc.creator_wallet_address;
        var meB = state.walletAddress === doc.counterparty_wallet_address;
        if (meA || meB) {
            var partyText = meA ? 'You are Party A (Creator)' : 'You are Party B (Counterparty)';
            $('doc-meta').textContent = partyText + ' · Created ' + formatDate(doc.created_at);
        }
        $('doc-hash').textContent = 'SHA-256: '+(doc.original_hash||'').slice(0,16)+'...';
        $('doc-hash').title = doc.original_hash;
        $('doc-hash').onclick = function(){navigator.clipboard.writeText(doc.original_hash);toast('Hash copied','info');};
        $('doc-file-info').textContent = formatSize(doc.file_size||0)+' · PDF';
        $('btn-download-original').onclick = function(e){e.preventDefault();window.open(API+'/documents/'+doc.doc_uuid+'/pdf','_blank');};

        renderPdf(API+'/documents/'+doc.doc_uuid+'/pdf','pdf-canvas');

        // No sig field placement — removed

        // Signatures
        $('sig-rows').innerHTML =
            sigRow('Creator (Party A)',doc.creator_wallet_address,doc.creator_signature,doc.creator_signed_at) +
            sigRow('Counterparty (Party B)',doc.counterparty_wallet_address,doc.counterparty_signature,doc.counterparty_signed_at,doc.counterparty_email);
        show('signatures-section');

        // Actions
        hide('sign-action'); hide('invite-action'); hide('finalize-action');
        hide('chain-proof'); hide('notary-seal'); hide('download-section');
        hide('sig-placement');

		// Draft — show pay button to resume
        if (me && doc.status==='draft') {
            show('payment-section-doc');
        }

        // Draft — show edit/pay/delete actions
        if (me && doc.status==='draft') {
            show('draft-actions');
            if ($('draft-pay-amount')) $('draft-pay-amount').textContent = state.feeKas;
        }

        // Show sign form directly after payment (no fields step)
        if (me && doc.status==='paid' && !doc.creator_signature) {
            show('sign-action'); $('btn-sign').disabled=true; $('input-sig-name').value=''; $('input-agree').checked=false;
        }

        // After creator signs, show invite status (auto-sent)
        if (me && doc.status==='pending_cosign') {
            show('invite-action');
            $('invite-status').textContent = doc.invite_sent_at ? 'Invitation sent to '+doc.counterparty_email+' on '+formatDate(doc.invite_sent_at) : 'Invitation being sent...';
            $('btn-send-invite').textContent = 'Resend Invitation';
        }

        // pending_finalization = seal failed, show retry
        if (me && doc.status==='pending_finalization') show('finalize-action');

        if (doc.status==='notarized') { show('chain-proof'); show('notary-seal'); show('download-section'); renderProof(doc); }
    }

    function sigRow(label,addr,sig,at,email) {
        var ok=!!sig, c=ok?'signed':'waiting';
        var ic=ok?'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>'
                  :'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>';
        var a=ok?truncAddr((sig&&sig.wallet_address)||addr):(email?'Awaiting '+email:'Awaiting...');
        var t=ok&&at?'<div class="sig-time">Signed '+formatDate(at)+'</div>':'';
        return '<div class="signature-row"><div class="sig-indicator '+c+'">'+ic+'</div><div class="sig-info"><div class="sig-label">'+esc(label)+'</div><div class="sig-address">'+esc(a)+'</div>'+t+'</div></div>';
    }

    function renderFields() {
        var l=$('sig-fields-list'); l.innerHTML='';
        state.signatureFields.forEach(function(f,i) {
            var d=document.createElement('div'); d.className='sig-field-item';
            d.innerHTML='<span>Field '+(i+1)+' — Page '+f.page+'</span><select data-i="'+i+'"><option value="A"'+(f.party==='A'?' selected':'')+'>My signature</option><option value="B"'+(f.party==='B'?' selected':'')+'>Counterparty</option></select><button class="sig-field-remove" data-i="'+i+'">×</button>';
            l.appendChild(d);
        });
        l.querySelectorAll('select').forEach(function(s){s.onchange=function(){state.signatureFields[+s.dataset.i].party=s.value;};});
        l.querySelectorAll('.sig-field-remove').forEach(function(b){b.onclick=function(){state.signatureFields.splice(+b.dataset.i,1);renderFields();};});
        $('btn-save-fields').disabled=state.signatureFields.length<2;
    }

    function saveFields() {
        if (!state.currentDoc||state.signatureFields.length<2) return;
        if (!state.signatureFields.some(function(f){return f.party==='A';})||!state.signatureFields.some(function(f){return f.party==='B';})) {
            toast('Need one field per party.','error'); return;
        }
        showLoading('Saving...');
        api('/documents/'+state.currentDoc.doc_uuid+'/fields',{method:'PUT',body:JSON.stringify({fields:state.signatureFields})}).then(function() {
            hideLoading(); toast('Fields saved.','success'); loadDocument(state.currentDoc.doc_uuid);
        }).catch(function(e){hideLoading();toast(e.message,'error');});
    }

    function checkSignReady() {
        $('btn-sign').disabled = !($('input-sig-name').value.trim() && $('input-agree').checked);
    }

    function signDoc() {
        var n=$('input-sig-name').value.trim();
        var agreed=$('input-agree').checked;
        if(!n||!agreed||!state.currentDoc) return;
        showLoading('Signing...');
        api('/documents/'+state.currentDoc.doc_uuid+'/sign',{method:'POST',body:JSON.stringify({signature:{type:'typed',value:n},agreed:true})}).then(function(d) {
            hideLoading(); toast('Document signed.','success'); loadDocument(state.currentDoc.doc_uuid);
        }).catch(function(e){hideLoading();toast('Signing failed: '+e.message,'error');});
    }

    function sendInvite() {
        if (!state.currentDoc) return;
        showLoading('Sending...');
        api('/documents/'+state.currentDoc.doc_uuid+'/invite',{method:'POST',body:JSON.stringify({})}).then(function(d) {
            hideLoading(); toast('Invitation sent to '+state.currentDoc.counterparty_email,'success');
            $('invite-status').textContent='Sent. Link: '+(d.invite_url||'');
            $('btn-send-invite').textContent='Resend Invitation';
        }).catch(function(e){hideLoading();toast(e.message,'error');});
    }

    function finalize() {
        if (!state.currentDoc) return;
        showLoading('Sealing on blockchain...');
        api('/documents/'+state.currentDoc.doc_uuid+'/finalize',{method:'POST',body:JSON.stringify({})}).then(function() {
            hideLoading(); toast('Notarized on Kaspa blockchain.','success'); loadDocument(state.currentDoc.doc_uuid);
        }).catch(function(e){hideLoading();toast(e.message,'error');});
    }

    function renderProof(doc) {
        var r=$('proof-rows'); r.innerHTML='';
        function row(l,v,link,mono) {
            var cls = mono ? ' mono' : '';
            var val=link&&v?'<a href="'+EXPLORER+v+'" target="_blank" class="mono">'+v.slice(0,20)+'...</a>':(v?'<span class="'+cls+'">'+esc(v)+'</span>':'—');
            return '<div class="proof-row"><span class="proof-label">'+l+'</span><span class="proof-value">'+val+'</span></div>';
        }
        r.innerHTML=
            row('Seal Transaction',doc.seal_tx_id,true)+
            row('Document Hash',doc.original_hash,false,true)+
            row('Party A',doc.creator_wallet_address?truncAddr(doc.creator_wallet_address):null)+
            row('Party B',doc.counterparty_wallet_address?truncAddr(doc.counterparty_wallet_address):null)+
            row('Sealed',formatDate(doc.notarized_at));
        $('seal-date').textContent=formatDateShort(doc.notarized_at);
    }

    // ── Invite flow (counterparty) ──
    function loadInvite(token) {
        state.inviteToken=token; showLoading('Loading...');
        api('/invite/'+token).then(function(d) {
            hideLoading(); state.inviteDoc=d.document; renderInvite(d.document);
        }).catch(function(e){hideLoading();toast(e.message,'error');showScreen('screen-landing');});
    }

    function renderInvite(doc) {
        showScreen('screen-invite');
        $('invite-desc').textContent=truncAddr(doc.creator_address)+' invited you to sign this agreement.';

        var isNotarized = doc.status === 'notarized';
        var pending = doc.status === 'pending_cosign';
        var statusText = pending ? 'Awaiting your signature' : (isNotarized ? 'Document sealed on the Kaspa blockchain' : 'Both parties have signed');
        $('invite-status-banner').className='status-banner '+(pending?'pending':'confirmed');
        $('invite-status-banner').textContent=statusText;

        $('invite-doc-title').textContent=doc.title;
        $('invite-doc-hash').textContent='SHA-256: '+(doc.original_hash||'').slice(0,16)+'...';
        $('invite-file-info').textContent=formatSize(doc.file_size||0)+' · PDF';
        renderPdf(API+'/invite/'+state.inviteToken+'/pdf','invite-pdf-canvas');

        // Show both signatures with actual data
        $('invite-sig-rows').innerHTML =
            sigRow('Creator (Party A)', doc.creator_address, doc.creator_signature, doc.creator_signed_at) +
            sigRow('Counterparty (Party B)', doc.counterparty_address, doc.counterparty_signature, doc.counterparty_signed_at, doc.counterparty_email);

        // Show which party the connected user is
        if (state.walletAddress) {
            var isCreator = state.walletAddress === doc.creator_address;
            var isCounter = state.walletAddress === doc.counterparty_address;
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
                '<div class="proof-row"><span class="proof-label">Seal Transaction</span><span class="proof-value"><a href="' + EXPLORER + doc.seal_tx_id + '" target="_blank" class="mono">' + doc.seal_tx_id.slice(0,20) + '...</a></span></div>' +
                '<div class="proof-row"><span class="proof-label">Document Hash</span><span class="proof-value mono" style="font-size:11px;word-break:break-all;">' + esc(doc.original_hash) + '</span></div>' +
                '<div class="proof-row"><span class="proof-label">Sealed</span><span class="proof-value">' + formatDate(doc.notarized_at) + '</span></div>' +
                '</div>';
            $('invite-sig-rows').parentNode.parentNode.insertBefore(txDiv, $('invite-already-signed'));
        }

		// Show/hide email field based on whether counterparty email is already known
        if (doc.counterparty_email) { hide('invite-email-group'); } else { show('invite-email-group'); }

        if (pending) { show('invite-sign-action'); hide('invite-already-signed'); hide('invite-sig-form'); show('btn-invite-connect'); $('invite-sig-name').value=''; $('btn-invite-sign').disabled=true; }
        else { hide('invite-sign-action'); show('invite-already-signed'); }
    }

    function inviteConnect() {
        connectWallet().then(function(ok) {
            if (ok) { show('invite-sig-form'); hide('btn-invite-connect'); toast('Connected: '+truncAddr(state.walletAddress),'success'); }
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
        var n=$('invite-sig-name').value.trim();
        var agreed=$('invite-agree').checked;
        if(!n||!agreed||!state.inviteDoc) return;
        var email = $('invite-email').value.trim();
        showLoading('Signing and sealing...');
        api('/documents/'+state.inviteDoc.doc_uuid+'/sign',{method:'POST',body:JSON.stringify({
            signature:{type:'typed',value:n},
            agreed:true,
            email: email || undefined
        })}).then(function(d) {
            hideLoading();
            if (d.status === 'notarized') {
                toast('Document signed and sealed on blockchain!', 'success');
            } else {
                toast('Document signed.', 'success');
            }
            loadInvite(state.inviteToken);
        }).catch(function(e){hideLoading();toast(e.message,'error');});
    }

    // ── Public proof ──
    function loadProof(uuid) {
        showLoading('Loading proof...');
        api('/proof/'+uuid).then(function(d) {
            hideLoading(); var p=d.proof;
            state.currentDoc={
                doc_uuid:p.doc_uuid,
                title:'Notarized Document',
                status:'notarized',
                original_hash:p.document_hash,
                creator_wallet_address:p.party_a,
                counterparty_wallet_address:p.party_b,
                seal_tx_id:p.seal_tx_id,
                creator_signed_at:p.party_a_signed,
                counterparty_signed_at:p.party_b_signed,
                notarized_at:p.notarized_at,
                creator_signature:{wallet_address:p.party_a},
                counterparty_signature:{wallet_address:p.party_b}
            };
            renderProofPage(state.currentDoc);
        }).catch(function(e){hideLoading();toast(e.message,'error');showScreen('screen-landing');});
    }

    function renderProofPage(doc) {
        showScreen('screen-document');
        var isSigner = state.walletAddress && (state.walletAddress === doc.creator_wallet_address || state.walletAddress === doc.counterparty_wallet_address);

        // Status banner
        $('doc-status-banner').outerHTML = statusBanner('notarized');

        // Title — generic for public, real title for signers
        $('doc-title').textContent = isSigner ? (doc.title || 'Notarized Document') : 'Notarized Document';

        // Party identity for signers
        if (isSigner) {
            var meA = state.walletAddress === doc.creator_wallet_address;
            $('doc-meta').textContent = (meA ? 'You are Party A (Creator)' : 'You are Party B (Counterparty)') + ' · Sealed ' + formatDate(doc.notarized_at);
        } else {
            $('doc-meta').textContent = 'Sealed ' + formatDate(doc.notarized_at);
        }

        // Hash — always visible (public data)
        $('doc-hash').textContent = 'SHA-256: ' + (doc.original_hash || '').slice(0, 16) + '...';
        $('doc-hash').title = doc.original_hash;
        $('doc-hash').onclick = function(){ navigator.clipboard.writeText(doc.original_hash); toast('Hash copied', 'info'); };

        // PDF viewer — only for signers
        hide('doc-body');
        $('doc-file-info').textContent = '';
        if (isSigner) {
            show('doc-body');
            $('doc-file-info').textContent = 'PDF · Visible only to signers';
            $('btn-download-original').onclick = function(e){ e.preventDefault(); window.open(API + '/documents/' + doc.doc_uuid + '/pdf', '_blank'); };
            renderPdf(API + '/documents/' + doc.doc_uuid + '/pdf', 'pdf-canvas');
        } else {
            $('doc-file-info').textContent = state.walletAddress ? 'Document visible only to the original signers.' : 'Connect your wallet to view the document (signers only).';
        }

        // Signatures — always show (wallets + dates are public on-chain)
        $('sig-rows').innerHTML =
            sigRow('Party A', doc.creator_wallet_address, doc.creator_signature, doc.creator_signed_at) +
            sigRow('Party B', doc.counterparty_wallet_address, doc.counterparty_signature, doc.counterparty_signed_at);
        show('signatures-section');

        // Hide all action buttons... Proof + seal — always visible
        hide('sign-action'); hide('invite-action'); hide('finalize-action');
        hide('chain-proof'); hide('notary-seal'); hide('download-section');
        hide('sig-placement'); hide('draft-actions'); hide('draft-edit-form');

        // Download — only for signers
        if (isSigner) { show('download-section'); } else { hide('download-section'); }
    }

    // ── Routing ──
	function route() {
        var p=window.location.pathname;
        var inv=p.match(/^\/invite\/([a-f0-9]+)$/); if(inv){loadInvite(inv[1]);return;}
        var prf=p.match(/^\/proof\/([a-f0-9-]+)$/); if(prf){loadProof(prf[1]);return;}
        var doc=p.match(/^\/document\/([a-f0-9-]+)$/); if(doc&&state.token){loadDocument(doc[1]);return;}
        if (state.token&&state.walletAddress) loadDashboard(); else loadArchive();
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

	// ── Public Archive ──
    function loadArchive() {
        showScreen('screen-archive'); setActiveNav('nav-archive');
        api('/archive').then(function(d) {
            var list = $('archive-list'); list.innerHTML = '';
            if (!d.documents || !d.documents.length) {
                list.innerHTML='<div class="dash-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg><p>No notarized documents yet</p></div>';
                return;
            }
            d.documents.forEach(function(doc) {
                var el = document.createElement('div');
                el.className = 'archive-card' + (doc.is_public ? ' public' : '');
                var title = doc.title ? esc(doc.title) : '<span class="private-label">Private Document</span>';
                var hashShort = (doc.original_hash || '').slice(0, 16) + '...';
                var html = '<div class="archive-card-top">';
                html += '<div class="archive-card-title">' + title + '</div>';
                html += '<span class="status-pill notarized">Notarized</span>';
                html += '</div>';
                html += '<div class="archive-card-meta">';
                html += '<span class="mono" style="font-size:11px;">' + esc(hashShort) + '</span>';
                html += '<span>' + formatDate(doc.notarized_at) + '</span>';
                html += '</div>';
                html += '<div class="archive-card-parties">';
                html += '<span>Party A: ' + truncAddr(doc.party_a) + '</span>';
                html += '<span>Party B: ' + truncAddr(doc.party_b) + '</span>';
                html += '</div>';
                if (doc.seal_tx_id) {
                    html += '<div class="archive-card-tx"><a href="' + EXPLORER + doc.seal_tx_id + '" target="_blank" class="mono">Seal TX: ' + doc.seal_tx_id.slice(0,16) + '...</a></div>';
                }
                if (doc.is_public) {
                    html += '<div class="archive-card-actions"><a href="' + API + '/archive/' + doc.doc_uuid + '/pdf" target="_blank" class="btn btn-secondary btn-sm">View PDF</a></div>';
                }
                html += '</div>';
                el.innerHTML = html;
                el.style.cursor = 'pointer';
                el.onclick = function() { history.pushState(null,'','/proof/' + doc.doc_uuid); loadProof(doc.doc_uuid); };
                list.appendChild(el);
            });
        }).catch(function(e) { console.error('Archive load error:', e); });
    }

    // ── Init ──
    function init() {
        updateHeader();
        api('/config').then(function(d){state.feeKas=d.fee_kas||5;state.merchantId=d.merchant_id;}).catch(function(){});

		$('btn-home').onclick=function(){history.pushState(null,'','/');if(state.token)loadDashboard();else loadArchive();};
		if ($('nav-archive')) $('nav-archive').onclick=function(){history.pushState(null,'','/');loadArchive();};
        if ($('nav-my-docs')) $('nav-my-docs').onclick=function(){history.pushState(null,'','/');loadDashboard();};
        if ($('nav-new-doc')) $('nav-new-doc').onclick=function(){showCreate();};
        if ($('nav-how')) $('nav-how').onclick=function(){showScreen('screen-how');setActiveNav('nav-how');};
        $('btn-connect').onclick=function(){connectWallet().then(function(ok){if(ok)loadDashboard();});};
        $('btn-disconnect').onclick=disconnect;
        $('btn-new-doc').onclick=showCreate;
        $('btn-back-dash').onclick=function(){history.pushState(null,'','/');loadDashboard();};
        $('btn-back-dash2').onclick=function(){history.pushState(null,'','/');loadDashboard();};
        $('input-title').oninput=checkCreate;
        $('input-email').oninput=checkCreate;
        $('input-creator-email').oninput=checkCreate;
        $('create-sig-name').oninput=checkCreate;
        $('create-agree').onchange=checkCreate;

        var uz=$('upload-zone');
        uz.onclick=function(){$('file-input').click();};
        $('file-input').onchange=function(e){if(e.target.files[0])pickFile(e.target.files[0]);};
        uz.ondragover=function(e){e.preventDefault();uz.classList.add('drag-over');};
        uz.ondragleave=function(){uz.classList.remove('drag-over');};
        uz.ondrop=function(e){e.preventDefault();uz.classList.remove('drag-over');if(e.dataTransfer.files[0])pickFile(e.dataTransfer.files[0]);};
        $('btn-file-remove').onclick=function(){state.uploadedFile=null;$('file-input').value='';show('upload-zone');hide('file-preview');hide('create-step-sign');checkCreate();};
        $('btn-create-submit').onclick=submitCreate;
        $('input-sig-name').oninput=checkSignReady;
        $('input-agree').onchange=checkSignReady;
        $('btn-sign').onclick=signDoc;
        $('btn-send-invite').onclick=sendInvite;
        $('btn-finalize').onclick=finalize;
        $('btn-download-signed').onclick=function(){if(state.currentDoc)window.open(API+'/documents/'+state.currentDoc.doc_uuid+'/download','_blank');};
        $('btn-invite-connect').onclick=inviteConnect;
        $('invite-sig-name').oninput=checkInviteSignReady;
        $('invite-agree').onchange=checkInviteSignReady;
        if ($('invite-email')) $('invite-email').oninput=checkInviteSignReady;
        $('btn-invite-sign').onclick=inviteSign;

        // Create-page invite buttons
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

        // PDF fullscreen buttons
        if ($('btn-pdf-fullscreen')) $('btn-pdf-fullscreen').onclick=function(){openPdfFullscreen('pdf-viewer', state.currentDoc ? state.currentDoc.title : 'Document');};
        if ($('btn-invite-pdf-fullscreen')) $('btn-invite-pdf-fullscreen').onclick=function(){openPdfFullscreen('invite-pdf-viewer', state.inviteDoc ? state.inviteDoc.title : 'Document');};

        window.onpopstate=route;

        // Pay fee button
		$('btn-pay-fee').onclick = payFee;

        // Draft actions
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
                item: 'Notary Fee — ' + (state.currentDoc.title || 'Document'),
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

        route();
    }

    if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();

