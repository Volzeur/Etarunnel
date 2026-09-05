const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, net, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/* ============================================================
   Etarunnel — YouTube + YouTube Music, one live service at a time
   ============================================================ */

const TOOLBAR_HEIGHT = 64;
const FONT_REVEAL_TIMEOUT = 6000;
const FONT_REVEAL_GRACE = 150;
const PARTITION = 'persist:tubedeck';

const SERVICES = {
  youtube: { url: 'https://www.youtube.com', name: 'Video' },
  music:   { url: 'https://music.youtube.com', name: 'Music' },
};

let win = null;
let toastWin = null;
let currentView = null;
let currentKey = null;
let pendingSwitch = null;
let waitingForFonts = false;
let currentTheme = 'dark';
let htmlFullScreen = false;
let fsPrevWinFullScreen = false;
let videoView = null; // Tracks the overlay video player

const hist = (wc) => wc.navigationHistory ?? wc;

function activeWC() {
  // If the video overlay is open, it takes focus
  if (videoView && !videoView.webContents.isDestroyed()) return videoView.webContents;
  const wc = currentView?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

/* ------------------- Video Overlay Management ------------------ */
function closeVideoView() {
  if (!videoView) return;
  console.log('[Etarunnel] Closing video overlay...');
  
  try { 
    if (win && !win.isDestroyed()) {
      win.contentView.removeChildView(videoView); 
    }
  } catch (e) { console.warn('[Etarunnel] removeChildView error:', e); }
  
  try {
    const wc = videoView.webContents;
    if (wc && !wc.isDestroyed()) {
      if (typeof wc.close === 'function') wc.close();
      else wc.destroy();
    }
  } catch (e) { console.warn('[Etarunnel] destroy error:', e); }
  
  videoView = null;
  layoutViews();
  const wc = activeWC();
  if (wc && !wc.isDestroyed()) wc.focus();
  broadcast();
}

/* ------------------- Psidio Close Button Injection ------------------- */
// Injects a floating "X" button into the Psidio overlay to close it
function injectCloseButton(wc) {
  const script = `
    (function() {
      if (document.getElementById('etarunnel-close-btn')) return;

      // 1. Inject the CSS styles to match Psidio's theme toggle
      const style = document.createElement('style');
      style.textContent = \`
        #etarunnel-close-btn {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 2147483647;
          width: 36px;
          height: 36px;
          border-radius: 8px;
          
          /* Use Psidio variables if available, otherwise fallback to YouTube/OS defaults */
          background: var(--surface, rgba(255, 255, 255, 0.9));
          border: 1px solid var(--border, rgba(0, 0, 0, 0.1));
          color: var(--text-primary, #000000);
          
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s ease;
          font-family: sans-serif;
          font-weight: 900;
          font-size: 18px;
          backdrop-filter: blur(5px);
        }

        #etarunnel-close-btn:hover {
          background: var(--surface-hover, rgba(0, 0, 0, 0.1));
          transform: scale(1.05);
        }

        /* Dark mode fallbacks for when Psidio variables aren't loaded yet */
        [dark="true"] #etarunnel-close-btn, 
        [data-theme="dark"] #etarunnel-close-btn {
          background: var(--surface, rgba(40, 40, 40, 0.9));
          border-color: var(--border, rgba(255, 255, 255, 0.1));
          color: var(--text-primary, #ffffff);
        }
        
        [dark="true"] #etarunnel-close-btn:hover,
        [data-theme="dark"] #etarunnel-close-btn:hover {
          background: var(--surface-hover, rgba(60, 60, 60, 0.9));
        }

        @media (max-width: 600px) {
          #etarunnel-close-btn {
            top: 12px;
            right: 12px;
          }
        }
      \`;
      document.head.appendChild(style);

      // 2. Create the button element
      const btn = document.createElement('button');
      btn.id = 'etarunnel-close-btn';
      btn.innerText = '✕';
      btn.setAttribute('aria-label', 'Close video overlay');
      
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = 'etarunnel://close';
      };
      
      document.body.appendChild(btn);
    })();
  `;
  wc.executeJavaScript(script).catch(e => console.warn('[Etarunnel] Close button injection failed:', e.message));
}

/* ------------------- Video Click Interceptor ------------------- */
function videoInterceptMainWorld() {
  if (window.__tdVideoIntercept) return;
  window.__tdVideoIntercept = true;

  const getVideoId = (urlStr) => {
    try {
      const parsedUrl = new URL(urlStr, window.location.origin);
      const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
      
      if ((hostname === 'youtube.com' || hostname === 'm.youtube.com') && parsedUrl.pathname === '/watch') {
        return parsedUrl.searchParams.get('v');
      }
      if (hostname === 'youtu.be') {
        return parsedUrl.pathname.slice(1).split(/[?#]/)[0];
      }
      // /shorts/ are ignored so they play natively
    } catch (e) {}
    return null;
  };

  const openPsidio = (videoId) => {
    console.log('[Etarunnel Page] Opening Psidio overlay for video:', videoId);
    window.open(`https://psidio.web.app/etarunnel/?watch=${videoId}`, '_blank');
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) {
      const href = a.getAttribute('href');
      if (href) {
        const videoId = getVideoId(href);
        if (videoId) {
          e.preventDefault();
          e.stopPropagation();
          openPsidio(videoId);
        }
      }
    }
  }, true);

  const originalPushState = history.pushState;
  history.pushState = function(state, title, url) {
    if (url) {
      const videoId = getVideoId(url);
      if (videoId) { openPsidio(videoId); return; }
    }
    return originalPushState.apply(this, arguments);
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function(state, title, url) {
    if (url) {
      const videoId = getVideoId(url);
      if (videoId) { openPsidio(videoId); return; }
    }
    return originalReplaceState.apply(this, arguments);
  };

  const originalOpen = window.open;
  window.open = function(url, name, features) {
    if (url) {
      const videoId = getVideoId(url);
      if (videoId) { openPsidio(videoId); return null; }
    }
    return originalOpen.call(window, url, name, features);
  };
}

/* --------------------------- Poppins --------------------------- */

const FONT_CACHE_FILE = 'poppins-v4.json';
const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap';
const FONT_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const FONT_OVERRIDES = `
:root, html, body {
  font-family: 'Poppins', 'Roboto', 'Segoe UI', sans-serif !important;
}
:host {
  font-family: 'Poppins', 'Roboto', 'Segoe UI', sans-serif !important;
}
*:not([class*="material-icons"]):not(.material-symbols-outlined):not(.material-symbols-rounded) {
  font-family: 'Poppins', 'Roboto', 'Segoe UI', sans-serif !important;
}
`;

const FALLBACK_CSS = `@import url('${FONT_CSS_URL}');\n${FONT_OVERRIDES}`;

let FONT_FACES = [];

function fontCachePath() {
  return path.join(app.getPath('userData'), FONT_CACHE_FILE);
}

function parseFontFaces(css) {
  const faces = [];
  for (const chunk of css.split('@font-face').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf('}'));
    const prop = (name) => {
      const m = body.match(new RegExp(name + 's*:s*([^;]+)'));
      return m ? m[1].trim().replace(/['"]/g, '') : null;
    };
    const src = body.match(/url\(\s*['"]?(https:[^'")]+)['"]?\s*\)/);
    if (!src) continue;
    faces.push({
      family: prop('font-family') || 'Poppins',
      weight: prop('font-weight') || '400',
      style: prop('font-style') || 'normal',
      unicodeRange: prop('unicode-range'),
      url: src[1],
    });
  }
  return faces;
}

async function buildPoppinsFonts() {
  try {
    const cached = JSON.parse(fs.readFileSync(fontCachePath(), 'utf8'));
    if (Array.isArray(cached) && cached.length) {
      FONT_FACES = cached;
      return;
    }
  } catch {}

  try {
    const res = await net.fetch(FONT_CSS_URL, { headers: { 'user-agent': FONT_FETCH_UA } });
    const parsed = parseFontFaces(await res.text());

    const faces = [];
    for (const p of parsed) {
      const r = await net.fetch(p.url);
      const mime = (r.headers.get('content-type') || 'font/woff2').split(';')[0].trim();
      const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
      faces.push({ family: p.family, w: p.weight, s: p.style, u: p.unicodeRange, mime, b64 });
    }

    FONT_FACES = faces;
    try { fs.writeFileSync(fontCachePath(), JSON.stringify(faces)); } catch {}
  } catch (err) {
    console.warn('[Etarunnel] Poppins download failed, using @import fallback:', err.message);
  }
}

function fontSetup(faces) {
  return (async () => {
    if (window.__tdFontsAdded) return JSON.stringify({ added: 'already' });
    window.__tdFontsAdded = true;

    const results = [];
    for (const f of faces) {
      try {
        const descriptors = { weight: f.w, style: f.s, display: 'swap' };
        if (f.u) descriptors.unicodeRange = f.u;
        const face = new FontFace(
          f.family || 'Poppins',
          'url(data:' + f.mime + ';base64,' + f.b64 + ')',
          descriptors
        );
        document.fonts.add(face);
        try { await face.load(); } catch (e) {}
        results.push(f.w + f.s.charAt(0) + ':' + face.status);
      } catch (e) {
        results.push(f.w + f.s.charAt(0) + ':THROW:' + (e.message || e));
      }
    }
    return JSON.stringify({ added: results });
  })();
}

function shadowInject(css) {
  try {
    if (window.__tubedeckFontHook) return JSON.stringify({ v: 6, already: true });
    window.__tubedeckFontHook = true;

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    window.__tdAdopted = 0;

    const adopt = (root) => {
      try {
        const list = root.adoptedStyleSheets;
        if (!list.includes(sheet)) {
          root.adoptedStyleSheets = [...list, sheet];
          window.__tdAdopted++;
        }
      } catch (e) {}
    };

    adopt(document);

    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = orig.call(this, init);
      adopt(root);
      return root;
    };

    const sweep = () => {
      const pending = window.__tdPendingRoots;
      if (pending && pending.length) {
        for (const r of pending) adopt(r);
        pending.length = 0;
      }
      const stack = [document];
      while (stack.length) {
        const root = stack.pop();
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) { adopt(el.shadowRoot); stack.push(el.shadowRoot); }
        }
      }
    };
    
    sweep();

    return JSON.stringify({ v: 6, adopted: window.__tdAdopted });
  } catch (err) {
    return JSON.stringify({ err: String((err && err.message) || err) });
  }
}

function injectPoppins(wc) {
  if (!wc || wc.isDestroyed()) return;

  if (FONT_FACES.length) {
    wc.insertCSS(FONT_OVERRIDES, { cssOrigin: 'user' })
      .catch((e) => console.warn('[Etarunnel] insertCSS(user):', e.message));
    wc.insertCSS(FONT_OVERRIDES, { cssOrigin: 'author' })
      .catch((e) => console.warn('[Etarunnel] insertCSS(author):', e.message));

    if (!wc.__tdFontsSent) {
      wc.__tdFontsSent = true;
      wc.executeJavaScript(`(${fontSetup.toString()})(${JSON.stringify(FONT_FACES)})`)
        .then(() => {
          wc.__tdResolveFonts?.();
        })
        .catch((e) => {
          console.warn('[Etarunnel] font setup failed:', e.message);
          wc.__tdResolveFonts?.();
        });
    }
  } else {
    wc.insertCSS(FALLBACK_CSS, { cssOrigin: 'user' }).catch(() => {});
    wc.__tdResolveFonts?.();
  }

  const now = Date.now();
  if (wc.__tdLastShadow && now - wc.__tdLastShadow < 1000) return;
  wc.__tdLastShadow = now;

  wc.executeJavaScript(`(${shadowInject.toString()})(${JSON.stringify(FONT_OVERRIDES)})`)
    .catch((e) => console.warn('[Etarunnel] shadow inject failed:', e.message));
}

/* --------------------- hidden-until-Poppins -------------------- */

function armFontsReveal(view) {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;

  const seq = (view.__tdWaitSeq = (view.__tdWaitSeq || 0) + 1);
  view.setVisible(false);
  waitingForFonts = true;
  broadcast();

  wc.__tdFontsReady = new Promise((resolve) => { wc.__tdResolveFonts = resolve; });

  Promise.race([
    wc.__tdFontsReady,
    new Promise((r) => setTimeout(r, FONT_REVEAL_TIMEOUT)),
  ]).then(() => setTimeout(() => {
    if (view.__tdWaitSeq === seq) revealView(view);
  }, FONT_REVEAL_GRACE));
}

function revealView(view) {
  if (!win || win.isDestroyed()) return;
  const wc = view.webContents;
  if (wc.isDestroyed() || currentView !== view) return;
  waitingForFonts = false;
  view.setVisible(true);
  layoutViews();
  wc.focus();
  broadcast();
}

/* --------------------------- session --------------------------- */

const AD_URL_FILTERS = [
  '*://*.doubleclick.net/*',
  '*://*.googleadservices.com/*',
  '*://*.googlesyndication.com/*',
  '*://adservice.google.com/*',
  '*://*.google-analytics.com/*',
  '*://*.youtube.com/pagead/*',
  '*://*.youtube.com/ptracking*',
  '*://*.youtube.com/get_midroll_info*',
];

function configureSession() {
  const ses = session.fromPartition(PARTITION);

  ses.webRequest.onHeadersReceived({ urls: ['*://*.youtube.com/*'] }, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    for (const name of Object.keys(responseHeaders)) {
      if (name.toLowerCase() === 'content-security-policy') delete responseHeaders[name];
    }
    callback({ responseHeaders });
  });

  ses.webRequest.onBeforeRequest({ urls: AD_URL_FILTERS }, (_details, callback) => {
    callback({ cancel: true });
  });
}

/* ------------------- service view lifecycle -------------------- */

function createServiceView(key) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'yt-preload.js'),
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const wc = view.webContents;

  // --- START: Intercept external links & Video overlay ---
  const isInternalHost = (hostname) => {
    if (!hostname) return false;
    return (
      hostname === 'youtube.com' || hostname.endsWith('.youtube.com') ||
      hostname === 'youtu.be' ||
      hostname === 'google.com' || hostname.endsWith('.google.com') ||
      hostname === 'gstatic.com' || hostname.endsWith('.gstatic.com') ||
      hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com') ||
      hostname === 'googleapis.com' || hostname.endsWith('.googleapis.com') ||
      hostname === 'googleadservices.com' || hostname.endsWith('.googleadservices.com') ||
      hostname === 'psidio.web.app'
    );
  };

  const getExternalUrl = (urlStr) => {
    try {
      const parsedUrl = new URL(urlStr);
      if (parsedUrl.protocol === 'about:' || parsedUrl.protocol === 'data:' || parsedUrl.protocol === 'blob:') return null;
      
      const hostname = parsedUrl.hostname.toLowerCase();
      
      if (hostname.endsWith('youtube.com') && parsedUrl.pathname === '/redirect') {
        const dest = parsedUrl.searchParams.get('q');
        if (dest) {
          try {
            const destParsed = new URL(dest);
            if (!isInternalHost(destParsed.hostname.toLowerCase())) {
              return dest;
            } else {
              return null;
            }
          } catch (e) {
            return null;
          }
        }
      }
      
      if (!isInternalHost(hostname)) {
        return urlStr;
      }
    } catch (err) {}
    return null;
  };

  wc.on('will-navigate', (event, url) => {
    const externalUrl = getExternalUrl(url);
    if (externalUrl) {
      event.preventDefault();
      shell.openExternal(externalUrl);
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    // 1. Handle Psidio Video Overlay
    if (url.includes('psidio.web.app/etarunnel/?watch=')) {
      if (!videoView) {
        videoView = new WebContentsView({
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            autoplayPolicy: 'no-user-gesture-required',
          }
        });
        win.contentView.addChildView(videoView);
        layoutViews();
        
        videoView.webContents.loadURL(url);
        
        // Inject Poppins font and the Close Button when the overlay loads
        videoView.webContents.on('dom-ready', () => {
          injectPoppins(videoView.webContents);
          injectCloseButton(videoView.webContents);
        });
        
        videoView.webContents.on('did-navigate', () => {
          injectCloseButton(videoView.webContents); // Re-inject in case of SPA route changes
        });

        // Intercept the custom close URL triggered by the close button
        videoView.webContents.on('will-navigate', (event, navUrl) => {
          if (navUrl.startsWith('etarunnel://close')) {
            event.preventDefault();
            closeVideoView();
            return;
          }
          if (!navUrl.includes('psidio.web.app')) {
            event.preventDefault();
            shell.openExternal(navUrl);
          }
        });

        videoView.webContents.on('destroyed', () => {
          if (videoView && videoView.webContents.isDestroyed()) {
            try { win.contentView.removeChildView(videoView); } catch(e){}
            videoView = null;
            layoutViews();
            activeWC()?.focus();
            broadcast();
          }
        });
      } else {
        videoView.webContents.loadURL(url);
      }
      return { action: 'deny' };
    }

    // 2. Handle standard external links
    const externalUrl = getExternalUrl(url);
    if (externalUrl) {
      shell.openExternal(externalUrl);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  // --- END: Intercept external links & Video overlay ---

  wc.on('dom-ready', () => {
    injectPoppins(wc);
    wc.executeJavaScript(`(${videoInterceptMainWorld.toString()})()`).catch(e => console.warn('[Etarunnel] Video intercept injection failed:', e.message));
  });
  
  wc.on('did-finish-load', () => injectPoppins(wc));
  
  wc.on('did-navigate', () => {
    wc.__tdFontsSent = false;
    armFontsReveal(view);
    wc.executeJavaScript(`(${videoInterceptMainWorld.toString()})()`).catch(() => {});
  });

  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) revealView(view);
  });

  wc.on('enter-html-full-screen', () => {
    htmlFullScreen = true;
    fsPrevWinFullScreen = win.isFullScreen();
    if (!fsPrevWinFullScreen) win.setFullScreen(true);
    layoutViews();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullScreen = false;
    if (!fsPrevWinFullScreen && win.isFullScreen()) win.setFullScreen(false);
    layoutViews();
  });

  wc.on('before-input-event', (event, input) => handlePageKeys(event, input, wc));

  wc.on('did-start-navigation', () => broadcast());
  wc.on('did-navigate', () => broadcast());
  wc.on('did-stop-loading', () => broadcast());
  wc.on('page-title-updated', () => broadcast());

  wc.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ]).popup();
    }
  });

  wc.loadURL(SERVICES[key].url);
  return view;
}

function loadService(key) {
  if (!SERVICES[key]) return;
  currentView = createServiceView(key);
  currentKey = key;
  win.contentView.addChildView(currentView);
  layoutViews();
  armFontsReveal(currentView);
}

function destroyCurrentView() {
  if (!currentView) return;
  const view = currentView;
  currentView = null;
  if (htmlFullScreen) {
    htmlFullScreen = false;
    if (!fsPrevWinFullScreen && win.isFullScreen()) win.setFullScreen(false);
  }
  view.__tdWaitSeq = (view.__tdWaitSeq || 0) + 1;
  win.contentView.removeChildView(view);
  try {
    if (typeof view.webContents.close === 'function') view.webContents.close();
    else view.webContents.destroy();
  } catch (e) {
    console.warn('[Etarunnel] view teardown:', e.message);
  }
}

function doSwitch(key) {
  if (!SERVICES[key]) return;
  
  // 1. If the Psidio overlay is open, destroy it first to free up memory
  if (videoView) {
    closeVideoView();
  }

  if (key === currentKey) {
    activeWC()?.focus();
    return;
  }
  
  // 2. Now proceed with the standard service switch
  destroyCurrentView();
  loadService(key);
}

function requestSwitch(key) {
  if (!SERVICES[key]) return;
  if (key === currentKey) {
    pendingSwitch = null;
    hideToast();
    activeWC()?.focus();
    return;
  }
  pendingSwitch = key;
  showConfirmToast(currentKey, key);
}

/* --------------------------- toast ----------------------------- */

function createToastWindow() {
  toastWin = new BrowserWindow({
    width: 400,
    height: 136,
    parent: win,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false, 
    webPreferences: {
      preload: path.join(__dirname, 'toast-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  toastWin.loadFile(path.join(__dirname, 'toast.html'));
}

function positionToast() {
  if (!toastWin || toastWin.isDestroyed() || !win || win.isDestroyed()) return;
  
  // SAFETY NET: Force the size to reset every time we calculate position
  toastWin.setSize(400, 136);
  
  const b = win.getBounds();
  const [w, h] = toastWin.getSize();
  
  const pixelsFromLeft = 280; // Adjust this to your liking
  const x = Math.round(b.x + pixelsFromLeft);
  const y = Math.round(b.y + TOOLBAR_HEIGHT + 8);

  toastWin.setPosition(x, y);
}

function trackToast() {
  if (toastWin && !toastWin.isDestroyed() && toastWin.isVisible()) positionToast();
}

function showConfirmToast(fromKey, toKey) {
  if (!toastWin || toastWin.isDestroyed()) createToastWindow();
  const data = { from: SERVICES[fromKey].name, to: SERVICES[toKey].name, theme: currentTheme };
  const present = () => {
    positionToast();
    toastWin.webContents.send('toast:show', data);
    toastWin.show();
    toastWin.focus();
  };
  if (toastWin.webContents.isLoading()) toastWin.webContents.once('did-finish-load', present);
  else present();
}

function hideToast() {
  if (toastWin && !toastWin.isDestroyed() && toastWin.isVisible()) toastWin.hide();
  if (win && !win.isDestroyed()) {
    win.focus();
    activeWC()?.focus();
  }
}

/* ---------------------------- window --------------------------- */

function createWindow() {
  win = new BrowserWindow({
    minWidth: 800,
    minHeight: 500,
    frame: false,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.maximize();

  win.once('ready-to-show', () => win.show());

  win.on('resize', () => { layoutViews(); trackToast(); });
  win.on('move', trackToast);
  win.on('maximize', () => { layoutViews(); trackToast(); broadcast(); });
  win.on('unmaximize', () => { layoutViews(); trackToast(); broadcast(); });
  win.on('minimize', hideToast);

  win.on('blur', () => {
    setTimeout(() => {
      if (!toastWin || toastWin.isDestroyed() || !toastWin.isVisible()) return;
      if (!toastWin.isFocused() && (!win || win.isDestroyed() || !win.isFocused())) {
        pendingSwitch = null;
        hideToast();
      }
    }, 250);
  });

  win.on('closed', () => {
    if (toastWin && !toastWin.isDestroyed()) toastWin.destroy();
    toastWin = null;
    win = null;
  });

  win.on('app-command', (event, command) => {
    if (command === 'browser-backward') { event.preventDefault(); navigate(-1); }
    if (command === 'browser-forward')  { event.preventDefault(); navigate(1); }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

function layoutViews() {
  if (!win || !currentView) return;
  const { width, height } = win.getContentBounds();
  const y = htmlFullScreen ? 0 : TOOLBAR_HEIGHT;
  const bounds = { x: 0, y, width, height: Math.max(0, height - y) };
  
  currentView.setBounds(bounds);
  if (videoView) {
    videoView.setBounds(bounds); // Ensure overlay covers the exact same area
  }
}

function broadcast(extra = {}) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const wc = activeWC();
  win.webContents.send('app:update', {
    active: currentKey,
    theme: currentTheme,
    serviceName: SERVICES[currentKey]?.name || '',
    waiting: waitingForFonts,
    canBack: videoView ? true : (wc ? hist(wc).canGoBack() : false),
    canForward: wc ? hist(wc).canGoForward() : false,
    title: wc ? wc.getTitle() : '',
    loading: wc ? wc.isLoading() : false,
    maximized: win.isMaximized(),
    ...extra,
  });
}

function navigate(dir) {
  // If pressing Back while the video overlay is open, close the overlay
  if (dir < 0 && videoView) {
    console.log('[Etarunnel] Back pressed while overlay is open. Closing overlay.');
    closeVideoView();
    return;
  }
  const wc = activeWC();
  if (!wc) return;
  if (dir < 0 && hist(wc).canGoBack()) wc.goBack();
  if (dir > 0 && hist(wc).canGoForward()) wc.goForward();
  broadcast();
}

function handlePageKeys(event, input, wc) {
  if (input.type !== 'keyDown') return;
  const key = (input.key || '').toLowerCase();
  const mod = input.meta || input.control;

  if (input.alt && key === 'arrowleft') {
    event.preventDefault();
    if (videoView) {
      console.log('[Etarunnel] Alt+Left pressed while overlay is open. Closing overlay.');
      closeVideoView();
    } else if (hist(wc).canGoBack()) {
      wc.goBack();
    }
  }
  else if (input.alt && key === 'arrowright')   { event.preventDefault(); wc.goForward(); }
  else if (mod && key === 'r')                  { event.preventDefault(); wc.reload(); }
  else if (mod && key === '1')                  { event.preventDefault(); requestSwitch('youtube'); }
  else if (mod && key === '2')                  { event.preventDefault(); requestSwitch('music'); }
  else if (mod && (key === '=' || key === '+')) { event.preventDefault(); wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5)); }
  else if (mod && key === '-')                  { event.preventDefault(); wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)); }
  else if (mod && key === '0')                  { event.preventDefault(); wc.setZoomLevel(0); }
  else if (mod && input.shift && key === 'i')   { event.preventDefault(); wc.openDevTools({ mode: 'detach' }); }
}

/* ------------------------------ ipc ---------------------------- */

ipcMain.on('app:request-switch', (_e, key) => requestSwitch(String(key)));
ipcMain.on('app:switch', (_e, key) => requestSwitch(String(key)));
ipcMain.on('nav:back', () => navigate(-1));
ipcMain.on('nav:forward', () => navigate(1));
ipcMain.on('nav:reload', () => activeWC()?.reload());
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:devtools', () => win?.webContents.toggleDevTools());
ipcMain.on('app:ready', () => broadcast());

ipcMain.on('yt:theme', (_e, theme) => {
  if (theme !== 'dark' && theme !== 'light') return;
  if (theme === currentTheme) return;
  currentTheme = theme;
  broadcast();
});

ipcMain.on('toast:confirm', () => {
  const key = pendingSwitch;
  pendingSwitch = null;
  hideToast();
  if (key) doSwitch(key);
});
ipcMain.on('toast:cancel', () => {
  pendingSwitch = null;
  hideToast();
});

/* ----------------------------- boot ---------------------------- */

async function boot() {
  currentTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  createWindow();
  createToastWindow();
  const fontsReady = buildPoppinsFonts();
  await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 2500))]);
  loadService('youtube');

  fontsReady.then(() => {
    const wc = activeWC();
    if (wc) {
      wc.__tdFontsSent = false;
      injectPoppins(wc);
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    configureSession();
    boot();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
