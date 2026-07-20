// ══════════════════════════════════════════════════════════════════════════════
// Groundwork CRM — Rich Text (terms & conditions, notes)
// richtext.js — lightweight contenteditable editor + HTML sanitizer + renderer
//
// Why: pasted terms from Word / Google Docs / PDFs lose bold, bullets and
// headings in plain <textarea>s. This module upgrades chosen textareas to a
// rich editor that keeps formatting on paste, stores sanitized HTML in the
// original (hidden) textarea so every existing save path keeps working, and
// provides _gwRichRender() so stored values (old plain text OR new HTML)
// render correctly on customer-facing documents.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

(function () {

  const ALLOWED = new Set(['P','DIV','BR','B','STRONG','I','EM','U','S','STRIKE','UL','OL','LI','H1','H2','H3','H4','A','BLOCKQUOTE']);

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _looksHtml(v) {
    return /<[a-z][^>]*>/i.test(String(v || ''));
  }

  // ── Sanitizer: whitelist tags, strip attributes/styles/scripts.
  //    Converts styled spans (Word/Docs paste) into semantic <b>/<i>/<u>.
  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<div id="__rt_root">' + String(html || '') + '</div>', 'text/html');
    const root = doc.getElementById('__rt_root');
    if (!root) return _esc(html);
    root.querySelectorAll('script,style,iframe,object,embed,form,link,meta,title,svg,img,video,audio,input,button,textarea,select').forEach(n => n.remove());

    const walk = (node) => {
      const kids = Array.from(node.childNodes);
      for (const ch of kids) {
        if (ch.nodeType === 8) { ch.remove(); continue; }      // comments
        if (ch.nodeType !== 1) continue;                        // text stays
        walk(ch);                                               // depth first
        const el = ch;
        const st = (el.getAttribute && el.getAttribute('style')) || '';
        const isBold  = /font-weight\s*:\s*(bold|bolder|[6-9]00)/i.test(st);
        const isItal  = /font-style\s*:\s*italic/i.test(st);
        const isUnder = /text-decoration[^;]*underline/i.test(st);

        // Wrap el's children in semantic tags for any inline styling found
        const wrapChildren = (target) => {
          if (!isBold && !isItal && !isUnder) return;
          const frag2 = doc.createDocumentFragment();
          let container = frag2;
          if (isBold)  { const t = doc.createElement('b'); container.appendChild(t); container = t; }
          if (isItal)  { const t = doc.createElement('i'); container.appendChild(t); container = t; }
          if (isUnder) { const t = doc.createElement('u'); container.appendChild(t); container = t; }
          while (target.firstChild) container.appendChild(target.firstChild);
          target.appendChild(frag2);
        };

        if (!ALLOWED.has(el.tagName)) {
          // Unwrap unknown tags (span, font, o:p, …), preserving styling semantically
          wrapChildren(el);
          const frag = doc.createDocumentFragment();
          while (el.firstChild) frag.appendChild(el.firstChild);
          el.parentNode.replaceChild(frag, el);
        } else {
          // Allowed tag: strip every attribute (class/style/onclick/href/…)
          for (const a of Array.from(el.attributes || [])) el.removeAttribute(a.name);
          // Preserve inline styling that lived on the allowed tag itself
          if (!/^(B|STRONG|I|EM|U)$/.test(el.tagName)) wrapChildren(el);
        }
      }
    };

    walk(root);
    return root.innerHTML;
  }

  // ── Public: render stored value (legacy plain text OR rich HTML) safely
  window._gwRichRender = function (v) {
    v = String(v || '');
    if (!v) return '';
    if (_looksHtml(v)) return sanitize(v);
    return _esc(v).replace(/\n/g, '<br>');
  };
  window._gwRichSanitize = sanitize;
  window._gwRichIsEmpty = function (v) {
    v = String(v || '');
    if (!_looksHtml(v)) return !v.trim();
    const d = document.createElement('div'); d.innerHTML = v;
    return !d.textContent.trim();
  };

  // ── Editor styles (injected once)
  function ensureCss() {
    if (document.getElementById('gw-rt-css')) return;
    const css = document.createElement('style');
    css.id = 'gw-rt-css';
    css.textContent = `
.gw-rt-wrap{border:1px solid var(--gw-border,#DDD8CE);border-radius:10px;background:#fff;overflow:hidden}
.gw-rt-wrap:focus-within{border-color:var(--gw-action,#2D7A55);box-shadow:0 0 0 3px rgba(45,122,85,.08)}
.gw-rt-toolbar{display:flex;gap:2px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--gw-line,#ECE8DF);background:var(--gw-bg-subtle,#FAF9F6);flex-wrap:wrap}
.gw-rt-btn{border:none;background:transparent;border-radius:6px;min-width:26px;height:26px;padding:0 6px;font-size:12.5px;color:var(--gw-text,#2F3B33);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit}
.gw-rt-btn:hover{background:rgba(45,122,85,.10)}
.gw-rt-btn.active{background:rgba(45,122,85,.16);color:var(--gw-action,#2D7A55)}
.gw-rt-sep{width:1px;height:16px;background:var(--gw-line,#ECE8DF);margin:0 4px}
.gw-rt-editor{min-height:110px;max-height:420px;overflow-y:auto;padding:10px 12px;font-size:12.5px;line-height:1.6;color:var(--gw-text,#2F3B33);outline:none}
.gw-rt-editor:empty::before{content:attr(data-placeholder);color:var(--gw-text-subtle,#9CA3AF);pointer-events:none}
.gw-rt-editor p{margin:0 0 8px}
.gw-rt-editor ul,.gw-rt-editor ol{margin:4px 0 10px;padding-left:22px}
.gw-rt-editor li{margin:2px 0}
.gw-rt-editor h1,.gw-rt-editor h2,.gw-rt-editor h3,.gw-rt-editor h4{margin:10px 0 6px;line-height:1.3}
.gw-rt-editor h1{font-size:16px}.gw-rt-editor h2{font-size:14.5px}.gw-rt-editor h3{font-size:13.5px}.gw-rt-editor h4{font-size:13px}
.gw-rt-hint{font-size:10.5px;color:var(--gw-text-subtle,#9CA3AF);padding:0 8px}
/* Shared display class for rendered rich text on documents */
.gw-rt-view p{margin:0 0 8px}
.gw-rt-view ul,.gw-rt-view ol{margin:4px 0 10px;padding-left:22px}
.gw-rt-view li{margin:2px 0}
.gw-rt-view h1,.gw-rt-view h2,.gw-rt-view h3,.gw-rt-view h4{margin:10px 0 6px;line-height:1.3;font-size:1.05em}
`;
    document.head.appendChild(css);
  }

  function toEditable(v) {
    v = String(v || '');
    if (!v) return '';
    if (_looksHtml(v)) return sanitize(v);
    return _esc(v).replace(/\n/g, '<br>');
  }

  // Inject shared styles at load so read-only .gw-rt-view renders (detail
  // pages, portal previews) are styled even before any editor is attached.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureCss);
  } else {
    ensureCss();
  }

  // ── Public: attach a rich editor to an existing <textarea>.
  //    The textarea is hidden and kept in sync (value = sanitized HTML), and an
  //    'input' event is dispatched on it so inline oninput handlers and
  //    page-level autosave listeners keep working unchanged.
  window._gwRichAttach = function (textareaId, opts) {
    opts = opts || {};
    const ta = document.getElementById(textareaId);
    if (!ta || ta.dataset.rtAttached === '1') return null;
    ensureCss();
    ta.dataset.rtAttached = '1';
    ta.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'gw-rt-wrap';
    wrap.id = textareaId + '-rtwrap';

    const bar = document.createElement('div');
    bar.className = 'gw-rt-toolbar';
    const BTNS = [
      ['bold', '<b>B</b>', 'Bold'],
      ['italic', '<i>I</i>', 'Italic'],
      ['underline', '<u>U</u>', 'Underline'],
      ['sep'],
      ['insertUnorderedList', '&bull; &mdash;', 'Bullet list'],
      ['insertOrderedList', '1. &mdash;', 'Numbered list'],
      ['sep'],
      ['removeFormat', 'Tx', 'Clear formatting'],
    ];
    const btnEls = {};
    BTNS.forEach(([cmd, label, title]) => {
      if (cmd === 'sep') { const s = document.createElement('span'); s.className = 'gw-rt-sep'; bar.appendChild(s); return; }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'gw-rt-btn'; b.innerHTML = label; b.title = title;
      b.addEventListener('mousedown', e => e.preventDefault()); // keep selection
      b.addEventListener('click', () => {
        editor.focus();
        try { document.execCommand(cmd, false, null); } catch (e) {}
        if (cmd === 'removeFormat') { try { document.execCommand('formatBlock', false, 'div'); } catch (e) {} }
        syncOut(); refreshActive();
      });
      btnEls[cmd] = b;
      bar.appendChild(b);
    });
    const hint = document.createElement('span');
    hint.className = 'gw-rt-hint';
    hint.textContent = 'Paste from Word or Docs keeps bold, bullets and headings';
    bar.appendChild(hint);

    const editor = document.createElement('div');
    editor.className = 'gw-rt-editor';
    editor.contentEditable = 'true';
    editor.setAttribute('data-placeholder', opts.placeholder || ta.getAttribute('placeholder') || '');
    if (opts.minHeight) editor.style.minHeight = opts.minHeight;
    editor.innerHTML = toEditable(ta.value);

    wrap.appendChild(bar);
    wrap.appendChild(editor);
    ta.parentNode.insertBefore(wrap, ta.nextSibling);

    function currentValue() {
      const html = sanitize(editor.innerHTML);
      const probe = document.createElement('div'); probe.innerHTML = html;
      if (!probe.textContent.trim()) return '';
      return html;
    }
    function syncOut() {
      const v = currentValue();
      if (ta.value === v) return;
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof opts.onChange === 'function') opts.onChange(v);
    }
    function refreshActive() {
      ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'].forEach(cmd => {
        const b = btnEls[cmd]; if (!b) return;
        let on = false;
        try { on = document.queryCommandState(cmd); } catch (e) {}
        b.classList.toggle('active', !!on);
      });
    }

    editor.addEventListener('input', syncOut);
    editor.addEventListener('keyup', refreshActive);
    editor.addEventListener('mouseup', refreshActive);
    editor.addEventListener('blur', syncOut);
    editor.addEventListener('paste', function (e) {
      e.preventDefault();
      const cd = e.clipboardData || window.clipboardData;
      const html = cd && cd.getData && cd.getData('text/html');
      const text = (cd && cd.getData && cd.getData('text/plain')) || '';
      const ins = html ? sanitize(html) : _esc(text).replace(/\n/g, '<br>');
      try { document.execCommand('insertHTML', false, ins); }
      catch (err) { editor.innerHTML += ins; }
      syncOut();
    });

    // Register so _gwRichSet can update the editor programmatically
    ta._gwRtEditor = editor;
    return editor;
  };

  // ── Public: set value programmatically (updates hidden textarea AND editor)
  window._gwRichSet = function (textareaId, value) {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    ta.value = String(value || '');
    if (ta._gwRtEditor) ta._gwRtEditor.innerHTML = toEditable(ta.value);
  };

})();
