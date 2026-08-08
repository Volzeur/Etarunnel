const api = window.tubedeck;
const $ = (s) => document.querySelector(s);
const body = document.body;

if (!api) {
  console.error('[Etarunnel toolbar] preload API missing — preload.js did not load');
}

const askSwitch = (key) => {
  if (api?.requestSwitch) api.requestSwitch(key);
  else if (api?.switch) api.switch(key);
  else console.error('[Etarunnel toolbar] no switch API available');
};

const els = {
  back: $('#btn-back'),
  forward: $('#btn-forward'),
  reload: $('#btn-reload'),
  title: $('#page-title'),
  toolbar: $('#toolbar'),
  bootName: $('#boot-name'),
  switchBtns: [...document.querySelectorAll('.switch-btn')],
};

/* controls */
els.back.addEventListener('click', () => api?.back());
els.forward.addEventListener('click', () => api?.forward());
els.reload.addEventListener('click', () => api?.reload());
$('#btn-min').addEventListener('click', () => api?.minimize());
$('#btn-max').addEventListener('click', () => api?.toggleMaximize());
$('#btn-close').addEventListener('click', () => api?.close());
els.switchBtns.forEach((btn) =>
  btn.addEventListener('click', () => {
    askSwitch(btn.dataset.service);
  })
);

/* double-click on empty toolbar space toggles maximize */
els.toolbar.addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  api?.toggleMaximize();
});

/* shortcuts while the toolbar itself has focus */
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.altKey && e.key === 'ArrowLeft')        { e.preventDefault(); api?.back(); }
  else if (e.altKey && e.key === 'ArrowRight')  { e.preventDefault(); api?.forward(); }
  else if (mod && k === 'r')                    { e.preventDefault(); api?.reload(); }
  else if (mod && e.key === '1')                { e.preventDefault(); askSwitch('youtube'); }
  else if (mod && e.key === '2')                { e.preventDefault(); askSwitch('music'); }
  else if (mod && e.shiftKey && k === 'i')      { e.preventDefault(); api?.devtools(); }
});

/* state pushed from main */
api?.onUpdate((s) => {
  body.dataset.active = s.active;
  if (s.theme) body.dataset.theme = s.theme;
  body.classList.toggle('loading', s.loading);
  body.classList.toggle('maximized', s.maximized);
  body.classList.toggle('waiting', !!s.waiting);
  if (s.serviceName && els.bootName) els.bootName.textContent = s.serviceName;
  els.back.disabled = !s.canBack;
  els.forward.disabled = !s.canForward;
  els.title.textContent = s.title || '';
});

api?.requestState();