/* Runs at document-start, before YouTube's scripts.
   IMPORTANT: preload scripts run in EVERY frame — including the live_chat
   iframe. Everything below is therefore gated to the top frame only. */
const { ipcRenderer, webFrame } = require('electron');

const IS_TOP_FRAME = (() => {
  try { return window.top === window; } catch (e) { return false; }
})();

if (IS_TOP_FRAME) {

  /* ---------- theme detection: watch YouTube's <html dark> and report it ---------- */
  const tdGetTheme = () => {
    const el = document.documentElement;
    if (!el) return null;
    if (el.hasAttribute('dark')) return 'dark';
    if (el.getAttribute('theme') === 'dark') return 'dark';
    if (el.classList && el.classList.contains('dark')) return 'dark';
    return 'light';
  };
  const tdReportTheme = () => {
    const t = tdGetTheme();
    if (t) { try { ipcRenderer.send('yt:theme', t); } catch (e) {} }
  };
  const tdObserveTheme = () => {
    try {
      const mo = new MutationObserver(() => tdReportTheme());
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['dark', 'theme'] });
    } catch (e) {}
    let checks = 0;
    const iv = setInterval(() => { tdReportTheme(); if (++checks >= 15) clearInterval(iv); }, 1000);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { tdReportTheme(); tdObserveTheme(); }, { once: true });
  } else {
    tdReportTheme();
    tdObserveTheme();
  }

  /* 1. early attachShadow hook (Poppins shadow-DOM coverage) */
  webFrame.executeJavaScript(`(() => {
    if (window.__tdEarlyHook) return;
    window.__tdEarlyHook = true;
    window.__tdPendingRoots = [];
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = orig.call(this, init);
      try { window.__tdPendingRoots.push(root); } catch (e) {}
      return root;
    };
  })()`).catch(() => {});

  /* 2. ad blocker + logo replacement engine */
  webFrame.executeJavaScript('(' + adblockMainWorld.toString() + ')()').catch(() => {});
}

function adblockMainWorld() {
  if (window.__tdAdblock) return;
  window.__tdAdblock = true;

  const AD_KEYS = new Set([
    'adPlacements', 'adSlots', 'playerAds', 'adSlotRenderer',
    'promotedVideoRenderer', 'displayAdRenderer', 'compactPromotedItemRenderer',
    'promotedSparklesWebRenderer', 'promotedSparklesTextSearchRenderer',
    'statementBannerRenderer', 'bannerPromoRenderer', 'carouselAdRenderer',
    'inFeedAdLayoutRenderer', 'actionCompanionAdRenderer', 'companionSlotRenderer',
    'brandVideoSingletonRenderer',
  ]);

  const prune = (node) => {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const v = node[i];
        if (v && typeof v === 'object') {
          const keys = Object.keys(v);
          if (keys.length === 1 && AD_KEYS.has(keys[0])) { node.splice(i, 1); continue; }
          prune(v);
        }
      }
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (AD_KEYS.has(k)) delete node[k];
        else prune(node[k]);
      }
    }
  };

  const isApiUrl = (u) => !!u && u.includes('/youtubei/v1/');

  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (isApiUrl(url) && (res.headers.get('content-type') || '').includes('json')) {
        const json = await res.clone().json();
        prune(json);
        const headers = new Headers(res.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        return new Response(JSON.stringify(json), {
          status: res.status, statusText: res.statusText, headers,
        });
      }
    } catch (e) {}
    return res;
  };

  const XOpen = XMLHttpRequest.prototype.open;
  const XSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { this.__tdUrl = String(url); } catch (e) {}
    return XOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__tdUrl && isApiUrl(this.__tdUrl)) {
      this.addEventListener('readystatechange', () => {
        if (this.readyState !== 4) return;
        try {
          const json = JSON.parse(this.responseText);
          prune(json);
          const txt = JSON.stringify(json);
          Object.defineProperty(this, 'responseText', { get: () => txt });
          Object.defineProperty(this, 'response', { get: () => txt });
        } catch (e) {}
      });
    }
    return XSend.apply(this, args);
  };

  const trap = (name) => {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => value,
        set: (v) => { try { value = prune(v); } catch (e) { value = v; } },
      });
    } catch (e) {}
  };
  trap('ytInitialPlayerResponse');
  trap('ytInitialData');

  const AD_SELECTOR = [
    'ytd-display-ad-renderer', 'ytd-promoted-video-renderer',
    'ytd-promoted-sparkles-web-renderer', 'ytd-promoted-sparkles-text-search-renderer',
    'ytd-ad-slot-renderer', '#masthead-ad', '#player-ads',
    'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer',
    'ytd-in-feed-ad-layout-renderer', 'ytd-companion-slot-renderer',
    'ytd-action-companion-ad-renderer', 'ytd-carousel-ad-renderer',
    'ytd-brand-video-singleton-renderer', 'ytd-rich-item-renderer[is-ad]',
    'ytd-reel-item-renderer[is-ad]', 'ytmusic-statement-banner-renderer',
    'ytd-enforcement-message-view-renderer',
  ].join(',');

  const BRAND_SELECTOR = [
    'ytd-topbar-logo-renderer',
    'ytmusic-logo-renderer',
    'ytd-masthead #logo',
    'ytmusic-nav-bar #logo',
    'ytmusic-nav-bar a#logo',
    'ytmusic-nav-bar .logo',
  ].join(',');

  const BRAND_LABEL = location.hostname.indexOf('music.youtube.com') !== -1 ? 'Music' : 'Video';

  const AD_CSS =
    AD_SELECTOR + ' { display: none !important; }' +
    ' ' + BRAND_SELECTOR + ' { display: none !important; }' +
    ' .td-brand-label {' +
    '   display: inline-flex; align-items: center;' +
    '   margin: 0 10px 0 16px;' +
    '   font-family: "Poppins", "Roboto", sans-serif;' +
    '   font-size: 20px; font-weight: 600; letter-spacing: .3px;' +
    '   color: var(--yt-spec-text-primary, var(--ytmusic-text-primary, inherit));' +
    '   user-select: none; cursor: default;' +
    ' }' +
    ' html[dark] .td-brand-label, html[theme="dark"] .td-brand-label { color: #f1f1f1; }' +
    ' tp-yt-paper-dialog:has(ytd-enforcement-message-view-renderer),' +
    ' ytd-popup-container:has(ytd-enforcement-message-view-renderer) { display: none !important; }';

  const clean = (root) => {
    try {
      for (const el of root.querySelectorAll(AD_SELECTOR)) el.remove();
      for (const el of root.querySelectorAll('ytd-popup-container tp-yt-paper-dialog')) {
        if (el.querySelector('ytd-enforcement-message-view-renderer')) el.remove();
      }
    } catch (e) {}
  };

  const ensureLabels = (root) => {
    try {
      if (root.querySelector('.td-brand-label')) return;
      const first = root.querySelector(BRAND_SELECTOR);
      if (!first) return;
      const span = document.createElement('span');
      span.className = 'td-brand-label';
      span.textContent = BRAND_LABEL;
      first.insertAdjacentElement('beforebegin', span);
    } catch (e) {}
  };

  let adSheet = null;

  const adoptInto = (root) => {
    try {
      const list = root.adoptedStyleSheets;
      if (adSheet && !list.includes(adSheet)) {
        root.adoptedStyleSheets = [...list, adSheet];
      }
    } catch (e) {}
  };

  const init = () => {
    try {
      adSheet = new CSSStyleSheet();
      adSheet.replaceSync(AD_CSS);
    } catch (e) {}

    adoptInto(document);
    ensureLabels(document);
    clean(document);

    const stack = [document];
    while (stack.length) {
      const root = stack.pop();
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          adoptInto(el.shadowRoot);
          ensureLabels(el.shadowRoot);
          stack.push(el.shadowRoot);
        }
      }
    }

    try {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches(AD_SELECTOR)) { n.remove(); continue; }
            if (n.matches && n.matches(BRAND_SELECTOR)) { ensureLabels(n.parentNode); continue; }
            // Only run heavy DOM queries on major grid containers, not every single node
            if (n.tagName === 'YTD-ITEM-SECTION-RENDERER' || 
                n.tagName === 'YTD-RICH-GRID-RENDERER' || 
                n.tagName === 'YTD-CONTINUATION-ITEM-RENDERER' ||
                n.tagName === 'YTD-THUMBNAIL-OVERLAY-TOGGLE-BUTTON-RENDERER') {
              clean(n);
              ensureLabels(n);
            }
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}