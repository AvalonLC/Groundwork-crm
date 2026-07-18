/* ═══════════════════════════════════════════════════════════════════════════
   Groundwork AI Setup Copilot — v20260718t26
   Gamified onboarding layer that works WITH the existing wizard + checklist:
   • Spotlight tours: dims the app, highlights exactly where to click, walks
     the user through each Getting Started task step-by-step.
   • AI chat: context-aware helper (knows current view + what's left to set
     up) that answers questions and can launch the matching tour.
   • Celebrations: confetti when checklist items complete; big moment at 100%.
   Nothing here replaces existing flows — it navigates and points, the user
   (or the normal UI) does the real work.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.gwCopilot) return;

  const Z_TOUR = 9400, Z_CHAT = 8600, Z_CONFETTI = 9900;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ── Element finder: try CSS selector, then visible text match ─────────── */
  function findEl(candidates) {
    for (const c of candidates || []) {
      if (c.sel) {
        const el = document.querySelector(c.sel);
        if (el && visible(el)) return el;
      }
      if (c.text) {
        const tags = c.tag ? [c.tag] : ['button', 'a', 'span', 'div', 'label', 'h1', 'h2', 'h3'];
        for (const tag of tags) {
          const els = Array.from(document.querySelectorAll(tag));
          const t = c.text.toLowerCase();
          const el = els.find(e => visible(e) && (e.textContent || '').trim().toLowerCase().includes(t));
          if (el) return el;
        }
      }
    }
    return null;
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight + 400;
  }
  function waitForEl(candidates, timeout) {
    return new Promise(resolve => {
      const t0 = Date.now();
      (function poll() {
        const el = findEl(candidates);
        if (el) return resolve(el);
        if (Date.now() - t0 > (timeout || 5000)) return resolve(null);
        setTimeout(poll, 220);
      })();
    });
  }

  /* ═══ TOUR DEFINITIONS — keyed by Getting Started checklist step id ═══════
     Each step: { view?, find?, title, body, tip?, clickToAdvance? }        */
  const TOURS = {
    cl_branding: {
      label: 'Add your branding',
      steps: [
        { view: 'settings', title: 'Your Company Settings', body: "This is where Groundwork becomes YOUR system. Your logo and brand color show up on every estimate, invoice, and client email you send.", tip: 'Clients trust branded documents — companies with a logo on estimates see noticeably better close rates.' },
        { find: [{ sel: '#sc-brand-btn2' }, { text: 'Save Branding' }, { sel: '#sc-brand-btn' }, { text: 'Save Logo' }], title: 'Upload your logo here', body: 'Pick your logo file and brand color, then hit this button to save. That\'s it — every document instantly rebrands.', tip: 'A square PNG with transparent background looks best.', clickToAdvance: true },
      ],
    },
    cl_client: {
      label: 'Add your first client',
      steps: [
        { view: 'clients', title: 'Your Client List', body: 'Every job starts with a client. This page holds everyone you work with — contact info, properties, job history, balances.', },
        { find: [{ text: '+ Add Client' }, { text: 'Add Client', tag: 'button' }], title: 'Click here to add one', body: 'Just a name and phone number is enough to start — you can fill in the rest anytime. Try adding a real customer right now.', tip: 'Have a spreadsheet of clients? Ask me about CSV import instead — it takes one minute.', clickToAdvance: true },
      ],
    },
    cl_pricebook: {
      label: 'Build your price book',
      steps: [
        { view: 'pricing', title: 'Services & Pricing', body: 'Your price book powers fast, consistent estimates. Load your services once, and building an estimate becomes point-and-click.', },
        { find: [{ text: '+ Add Item' }, { text: 'Import CSV' }], title: 'Add a service or import your list', body: 'Click "+ Add Item" to add one service (name, unit, price) — or use Import CSV to load your whole list at once.', tip: 'Start with your 5 most common services. You can always add more.', clickToAdvance: true },
      ],
    },
    cl_estimate: {
      label: 'Create your first estimate',
      steps: [
        { view: 'estimates', title: 'Estimates', body: 'This is where deals happen. Estimates you build here can be emailed to clients, accepted online, and converted to invoices in one click.', },
        { find: [{ text: 'New Estimate', tag: 'button' }], title: 'Start one here', body: 'Click New Estimate, pick a client, add line items from your price book. It takes about 60 seconds once your pricing is loaded.', tip: 'Estimates auto-calculate taxes and totals — and clients can approve them from their phone.', clickToAdvance: true },
      ],
    },
    cl_workorder: {
      label: 'Schedule your first job',
      steps: [
        { view: 'dispatchBoard', title: 'The Dispatch Board', body: 'Your operational command center — every job, crew, and day at a glance. Drag jobs between days, assign crews, track status by color.', },
        { find: [{ text: 'New Work Order' }, { text: '+ New Work Order' }], title: 'Create a work order', body: 'Click here to schedule a job — pick the client, date, and crew. It shows up instantly on the board and on your crew\'s view.', tip: 'Yellow = hold, green = scheduled. Estimates can auto-create work orders when accepted.', clickToAdvance: true },
      ],
    },
    cl_invoice: {
      label: 'Send your first invoice',
      steps: [
        { view: 'invoices', title: 'Invoices', body: 'Getting paid, made simple. Track what\'s outstanding, what\'s overdue, and what\'s been collected — all in one place.', },
        { find: [{ text: 'New Invoice', tag: 'button' }], title: 'Create one here', body: 'Click New Invoice — or even faster, convert an accepted estimate into an invoice with one click from the estimate page.', tip: 'Connect Stripe (next task!) and clients can pay invoices online instantly.', clickToAdvance: true },
      ],
    },
    cl_payments: {
      label: 'Connect online payments',
      steps: [
        { view: 'integrations', title: 'Integrations', body: 'This page connects Groundwork to the outside world — payments, Google Calendar and email, and more.', },
        { find: [{ text: 'Connect Stripe' }], title: 'Connect Stripe here', body: 'Click to link a Stripe account (free to create). Once connected, every invoice gets a "Pay Now" button — most businesses see payments arrive days faster.', tip: 'Stripe handles cards + ACH. Funds land directly in YOUR bank account.', clickToAdvance: true },
      ],
    },
    cl_team: {
      label: 'Invite your team',
      steps: [
        { view: 'userManagement', title: 'Your Team', body: 'Groundwork works best when the whole crew is in. Office staff get full access; field crews get a simplified mobile view with just their jobs.', },
        { find: [{ text: 'Send Invite' }, { text: 'Invite' }], title: 'Send an invite', body: 'Click here, enter their email, and pick a role. They get a link to set their own password — you control what each role can see.', tip: 'Foremen and laborers automatically land in the mobile Field Mode — no training needed.', clickToAdvance: true },
      ],
    },
    cl_google: {
      label: 'Connect Google',
      steps: [
        { view: 'integrations', title: 'Google Workspace', body: 'Connect Google to sync your calendar both ways and send emails from your real address — estimates and invoices arrive from you, not a robot.', },
        { find: [{ text: 'Connect Google' }, { text: 'Google', tag: 'h3' }], title: 'Connect your account', body: 'Click connect and approve in the popup. Scheduled jobs appear on your Google Calendar, and email replies flow into the client timeline.', clickToAdvance: true },
      ],
    },
    cl_reviews: {
      label: 'Set up review requests',
      steps: [
        { view: 'reviews', title: 'Review Engine', body: 'More 5-star reviews on autopilot. When a job wraps up, Groundwork can text/email the client asking for a Google review.', tip: 'Businesses that ask get 3–5× more reviews. Set your Google review link here and turn it on.' },
      ],
    },
  };

  /* ═══ SPOTLIGHT TOUR ENGINE ═══════════════════════════════════════════════ */
  const T = { active: null, idx: 0, els: {}, clickHandler: null };

  function tourRoot() {
    let r = document.getElementById('gwCpTour');
    if (!r) {
      r = document.createElement('div');
      r.id = 'gwCpTour';
      document.body.appendChild(r);
    }
    return r;
  }

  async function startTour(key) {
    const tour = TOURS[key];
    if (!tour) { openChat("How do I " + (key || 'get set up') + "?"); return; }
    endTour(true);
    document.getElementById('gwGSPanel')?.remove();
    T.active = { key, tour };
    T.idx = 0;
    await showStep();
  }

  async function showStep() {
    if (!T.active) return;
    const steps = T.active.tour.steps;
    if (T.idx >= steps.length) return finishTour();
    const step = steps[T.idx];
    const root = tourRoot();

    // Navigate if needed
    if (step.view && typeof window.show === 'function') {
      root.innerHTML = `<div style="position:fixed;inset:0;z-index:${Z_TOUR};background:rgba(13,35,24,.35);display:flex;align-items:center;justify-content:center"><div style="background:#fff;border-radius:14px;padding:18px 26px;font-weight:800;color:#1F2937;box-shadow:0 12px 40px rgba(0,0,0,.25)">✨ Taking you there…</div></div>`;
      try { window.show(step.view); } catch (e) {}
      await new Promise(r => setTimeout(r, 900));
    }

    let target = null;
    if (step.find) target = await waitForEl(step.find, 4500);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await new Promise(r => setTimeout(r, target ? 420 : 0));
    renderStep(step, target);
  }

  function renderStep(step, target) {
    const root = tourRoot();
    const steps = T.active.tour.steps;
    const isLast = T.idx === steps.length - 1;
    const rect = target ? target.getBoundingClientRect() : null;
    const pad = 8;

    // Spotlight hole (box-shadow trick) + pulsing ring
    const hole = rect
      ? `<div style="position:fixed;left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px;border-radius:12px;box-shadow:0 0 0 9999px rgba(13,35,24,.62);z-index:${Z_TOUR};pointer-events:none;transition:all .3s"></div>
         <div class="gwcp-pulse" style="position:fixed;left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px;border-radius:12px;border:3px solid #4ADE80;z-index:${Z_TOUR + 1};pointer-events:none"></div>`
      : `<div style="position:fixed;inset:0;background:rgba(13,35,24,.62);z-index:${Z_TOUR};pointer-events:none"></div>`;

    // Card position: below target if room, else above, else centered
    let cardPos = `left:50%;top:50%;transform:translate(-50%,-50%)`;
    if (rect) {
      const below = rect.bottom + 14, cardH = 240, cardW = 360;
      let left = Math.min(Math.max(rect.left, 12), innerWidth - cardW - 12);
      if (below + cardH < innerHeight) cardPos = `left:${left}px;top:${below}px`;
      else if (rect.top - cardH - 14 > 0) cardPos = `left:${left}px;top:${rect.top - cardH - 14}px`;
    }

    root.innerHTML = hole + `
    <div id="gwCpCard" style="position:fixed;${cardPos};z-index:${Z_TOUR + 2};width:360px;max-width:calc(100vw - 24px);background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden;font-family:inherit;animation:gwcpIn .25s ease">
      <div style="background:linear-gradient(135deg,#1C3A2B,#2D7A55);padding:13px 18px;display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">✨</span>
        <span style="flex:1;color:#fff;font-size:12px;font-weight:800;letter-spacing:.04em">GROUNDWORK GUIDE · ${T.idx + 1} OF ${steps.length}</span>
        <button onclick="gwCopilot.endTour()" style="background:none;border:none;color:rgba(255,255,255,.8);font-size:16px;cursor:pointer;line-height:1;padding:0">✕</button>
      </div>
      <div style="padding:16px 18px 6px">
        <div style="font-size:15.5px;font-weight:800;color:#1F2937">${esc(step.title)}</div>
        <div style="font-size:13px;color:#4B5563;margin-top:6px;line-height:1.55">${esc(step.body)}</div>
        ${step.tip ? `<div style="margin-top:10px;background:#F0FAF4;border:1px solid #2D7A5526;border-radius:10px;padding:9px 12px;font-size:12px;color:#1F5138;line-height:1.5"><b>💡 Pro tip:</b> ${esc(step.tip)}</div>` : ''}
        ${step.clickToAdvance && target ? `<div style="margin-top:10px;font-size:12px;font-weight:700;color:#8B6914">👆 Click the highlighted button to do it now — or press Next to keep touring.</div>` : ''}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 18px 15px">
        <div style="display:flex;gap:5px">${steps.map((_, i) => `<span style="width:7px;height:7px;border-radius:50%;background:${i === T.idx ? '#2D7A55' : '#D1D5DB'}"></span>`).join('')}</div>
        <div style="display:flex;gap:8px">
          ${T.idx > 0 ? `<button onclick="gwCopilot.prevStep()" style="background:none;border:1.5px solid #E5E7EB;border-radius:9px;padding:8px 14px;font-size:12.5px;font-weight:700;color:#6B7280;cursor:pointer">← Back</button>` : ''}
          <button onclick="gwCopilot.nextStep()" style="background:#2D7A55;border:none;border-radius:9px;padding:8px 18px;font-size:12.5px;font-weight:800;color:#fff;cursor:pointer">${isLast ? 'Done ✓' : 'Next →'}</button>
        </div>
      </div>
    </div>
    <style>
      @keyframes gwcpIn { from { opacity:0; transform:translateY(8px) } to { opacity:1 } }
      .gwcp-pulse { animation: gwcpPulse 1.6s ease-in-out infinite; }
      @keyframes gwcpPulse { 0%,100% { box-shadow:0 0 0 0 rgba(74,222,128,.55) } 50% { box-shadow:0 0 0 10px rgba(74,222,128,0) } }
    </style>`;

    // Clicking the real target advances the tour (target stays fully interactive)
    if (T.clickHandler && T.els.target) T.els.target.removeEventListener('click', T.clickHandler);
    T.els.target = target;
    if (target && step.clickToAdvance) {
      T.clickHandler = () => setTimeout(() => { if (T.active) nextStep(); }, 350);
      target.addEventListener('click', T.clickHandler, { once: true });
    }
  }

  function nextStep() { if (!T.active) return; T.idx++; showStep(); }
  function prevStep() { if (!T.active) return; T.idx = Math.max(0, T.idx - 1); showStep(); }

  async function finishTour() {
    const key = T.active && T.active.key;
    endTour(true);
    confetti(28);
    toast('Nice! You know your way around this one. 🎉');
    // Refresh the Getting Started state and celebrate real completions
    setTimeout(checkCelebrate, 1200);
  }

  function endTour(silent) {
    if (T.clickHandler && T.els.target) { try { T.els.target.removeEventListener('click', T.clickHandler); } catch (e) {} }
    T.active = null; T.idx = 0; T.els = {}; T.clickHandler = null;
    document.getElementById('gwCpTour')?.remove();
  }

  /* ═══ AI CHAT PANEL ═══════════════════════════════════════════════════════ */
  const C = { msgs: [], busy: false };

  function openChat(prefill) {
    document.getElementById('gwCpChat')?.remove();
    const p = document.createElement('div');
    p.id = 'gwCpChat';
    p.style.cssText = `position:fixed;bottom:80px;right:22px;z-index:${Z_CHAT};width:min(400px,calc(100vw - 44px));height:min(540px,calc(100vh - 120px));background:#fff;border:1.5px solid #E5E7EB;border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;font-family:inherit`;
    p.innerHTML = `
    <div style="background:linear-gradient(135deg,#1C3A2B,#2D7A55);padding:15px 18px;color:#fff;display:flex;align-items:center;gap:10px">
      <span style="font-size:20px">✨</span>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:800">Groundwork AI</div>
        <div style="font-size:11px;opacity:.85">Your setup copilot — ask me anything</div>
      </div>
      <button onclick="document.getElementById('gwCpChat').remove()" style="background:none;border:none;color:#fff;font-size:17px;cursor:pointer;line-height:1">✕</button>
    </div>
    <div id="gwCpMsgs" style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:#FAFAF8"></div>
    <div id="gwCpChips" style="padding:0 16px 8px;display:flex;gap:6px;flex-wrap:wrap;background:#FAFAF8"></div>
    <div style="display:flex;gap:8px;padding:12px 14px;border-top:1px solid #F3F4F6;background:#fff">
      <input id="gwCpInput" placeholder="e.g. How do I import my clients?" style="flex:1;padding:10px 12px;border:1.5px solid #E5E7EB;border-radius:11px;font-size:13px;outline:none;font-family:inherit" onkeydown="if(event.key==='Enter')gwCopilot.send()">
      <button onclick="gwCopilot.send()" style="background:#2D7A55;border:none;border-radius:11px;padding:10px 16px;color:#fff;font-size:13px;font-weight:800;cursor:pointer">Send</button>
    </div>`;
    document.body.appendChild(p);

    if (!C.msgs.length) {
      addMsg('ai', "Hi! I'm your Groundwork setup copilot. 👋\n\nI can answer questions, or literally walk you to the right screen and point at what to click. What would you like to do?");
      renderChips([
        ['Show me how to add a client', 'tour:cl_client'],
        ['Set up my price book', 'tour:cl_pricebook'],
        ['How do I get paid online?', 'tour:cl_payments'],
        ['Import my data', 'q:How do I import my existing clients and prices from a spreadsheet?'],
      ]);
    } else {
      C.msgs.forEach(m => paintMsg(m));
    }
    const inp = document.getElementById('gwCpInput');
    if (prefill) inp.value = prefill;
    inp.focus();
  }

  function renderChips(chips) {
    const el = document.getElementById('gwCpChips');
    if (!el) return;
    el.innerHTML = (chips || []).map(([label, act]) =>
      `<button onclick="gwCopilot.chip('${esc(act)}')" style="background:#F0FAF4;border:1.5px solid #2D7A5533;color:#2D7A55;font-size:11.5px;font-weight:700;padding:6px 11px;border-radius:11px;cursor:pointer;font-family:inherit">${esc(label)}</button>`).join('');
  }

  function chip(act) {
    if (act.startsWith('tour:')) { document.getElementById('gwCpChat')?.remove(); startTour(act.slice(5)); }
    else if (act.startsWith('q:')) { const i = document.getElementById('gwCpInput'); if (i) { i.value = act.slice(2); } send(); }
  }

  function addMsg(role, text, tourKey) {
    const m = { role, text, tourKey };
    C.msgs.push(m);
    paintMsg(m);
  }
  function paintMsg(m) {
    const box = document.getElementById('gwCpMsgs');
    if (!box) return;
    const isAi = m.role === 'ai';
    const div = document.createElement('div');
    div.style.cssText = `max-width:86%;padding:10px 13px;border-radius:${isAi ? '4px 14px 14px 14px' : '14px 4px 14px 14px'};font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;${isAi ? 'background:#fff;border:1px solid #EDEDE8;color:#1F2937;align-self:flex-start' : 'background:#2D7A55;color:#fff;align-self:flex-end'}`;
    div.textContent = m.text;
    if (isAi && m.tourKey && TOURS[m.tourKey]) {
      const btn = document.createElement('button');
      btn.textContent = '✨ Show me — walk me through it';
      btn.style.cssText = 'display:block;margin-top:9px;background:#2D7A55;border:none;border-radius:9px;padding:8px 14px;color:#fff;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit';
      btn.onclick = () => { document.getElementById('gwCpChat')?.remove(); startTour(m.tourKey); };
      div.appendChild(btn);
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  async function send() {
    const inp = document.getElementById('gwCpInput');
    const q = (inp && inp.value || '').trim();
    if (!q || C.busy) return;
    inp.value = '';
    renderChips([]);
    addMsg('user', q);
    C.busy = true;
    const thinking = document.createElement('div');
    thinking.id = 'gwCpThink';
    thinking.style.cssText = 'align-self:flex-start;padding:10px 14px;background:#fff;border:1px solid #EDEDE8;border-radius:4px 14px 14px 14px;font-size:13px;color:#9CA3AF';
    thinking.textContent = '✨ thinking…';
    document.getElementById('gwCpMsgs')?.appendChild(thinking);

    let checklist = [];
    try {
      const r = await fetch('/api/onboarding/checklist', { credentials: 'include' });
      const raw = await r.json(); const d = (raw && raw.data) || raw;
      checklist = (d.items || []).map(i => ({ id: i.id, title: i.title, done: !!i.done }));
    } catch (e) {}

    try {
      const r = await fetch('/api/ai/copilot', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, view: (location.hash || '').replace('#', '') || 'dashboard', checklist }),
      });
      const raw = await r.json();
      const d = (raw && raw.data) || raw;
      document.getElementById('gwCpThink')?.remove();
      if (!r.ok || d.error) {
        addMsg('ai', d.message || "I couldn't reach the AI service right now. Your admin may need to enable AI under Integrations — but the guided tours still work! Try one of the buttons below.");
        renderChips([['Add a client', 'tour:cl_client'], ['Price book', 'tour:cl_pricebook'], ['First estimate', 'tour:cl_estimate'], ['Get paid online', 'tour:cl_payments']]);
      } else {
        addMsg('ai', d.answer || 'Done!', d.tour && TOURS[d.tour] ? d.tour : null);
      }
    } catch (e) {
      document.getElementById('gwCpThink')?.remove();
      addMsg('ai', 'Network hiccup — try again in a moment.');
    }
    C.busy = false;
  }

  /* ═══ CELEBRATIONS ════════════════════════════════════════════════════════ */
  function confetti(n) {
    const colors = ['#2D7A55', '#4ADE80', '#8B6914', '#F5C518', '#7B5EA7', '#5B7FA6'];
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z_CONFETTI};overflow:hidden`;
    for (let i = 0; i < (n || 30); i++) {
      const p = document.createElement('div');
      const size = 6 + Math.random() * 8;
      p.style.cssText = `position:absolute;left:${Math.random() * 100}%;top:-20px;width:${size}px;height:${size * (Math.random() > .5 ? 1 : .4)}px;background:${colors[i % colors.length]};border-radius:${Math.random() > .5 ? '50%' : '2px'};transition:transform ${1.6 + Math.random() * 1.4}s cubic-bezier(.2,.6,.4,1), opacity .4s ${1.4 + Math.random()}s;transform:translateY(0) rotate(0)`;
      wrap.appendChild(p);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        p.style.transform = `translateY(${innerHeight + 60}px) translateX(${(Math.random() - .5) * 220}px) rotate(${(Math.random() - .5) * 720}deg)`;
        p.style.opacity = '0';
      }));
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 3400);
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);z-index:${Z_CONFETTI};background:#1C3A2B;color:#fff;padding:12px 22px;border-radius:14px;font-size:13.5px;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;transition:all .3s;font-family:inherit`;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateX(-50%)'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 3200);
  }

  // Celebrate NEW checklist completions since last check (localStorage-tracked)
  async function checkCelebrate() {
    let d;
    try {
      const r = await fetch('/api/onboarding/checklist', { credentials: 'include' });
      const raw = await r.json(); d = (raw && raw.data) || raw;
    } catch (e) { return; }
    if (!d || !d.total) return;
    const prev = parseInt(localStorage.getItem('gwCpDone') || '-1', 10);
    localStorage.setItem('gwCpDone', String(d.done));
    if (prev >= 0 && d.done > prev) {
      confetti(40);
      if (d.done >= d.total && !localStorage.getItem('gwCpAllDone')) {
        localStorage.setItem('gwCpAllDone', '1');
        bigCelebration();
      } else {
        toast(`🎉 ${d.done} of ${d.total} setup tasks done — you're on a roll!`);
      }
    }
    // Refresh GS launcher badge if present
    const badge = document.querySelector('#gwGSLauncher span');
    if (badge) badge.textContent = `${d.done}/${d.total}`;
  }

  function bigCelebration() {
    confetti(80); setTimeout(() => confetti(60), 500);
    const o = document.createElement('div');
    o.id = 'gwCpGrad';
    o.style.cssText = `position:fixed;inset:0;z-index:${Z_CONFETTI - 1};background:rgba(13,35,24,.7);display:flex;align-items:center;justify-content:center;padding:20px`;
    o.innerHTML = `<div style="background:#fff;border-radius:22px;max-width:430px;width:100%;padding:36px 32px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.4);font-family:inherit">
      <div style="font-size:52px">🏆</div>
      <div style="font-size:22px;font-weight:900;color:#1F2937;margin-top:10px">Setup Complete!</div>
      <div style="font-size:14px;color:#4B5563;margin-top:10px;line-height:1.6">You've knocked out every Getting Started task. Your account is fully armed — clients, pricing, estimates, payments, the works. Time to go win some business. 💪</div>
      <button onclick="document.getElementById('gwCpGrad').remove()" style="margin-top:22px;background:#2D7A55;border:none;border-radius:12px;padding:13px 30px;color:#fff;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">Let's Go →</button>
    </div>`;
    document.body.appendChild(o);
  }

  // Baseline the done-count on load (no celebration on first visit), then watch
  setTimeout(() => {
    try {
      const rep = window._d1SessionRep;
      if (rep && rep.company_id === 'groundwork_platform') return; // not for platform account
    } catch (e) {}
    checkCelebrate();
  }, 4000);

  /* ═══ PUBLIC API ══════════════════════════════════════════════════════════ */
  window.gwCopilot = { startTour, endTour, nextStep, prevStep, openChat, send, chip, checkCelebrate, confetti, TOURS };
  console.log('[Groundwork] gw_copilot.js loaded v20260718t26');
})();
