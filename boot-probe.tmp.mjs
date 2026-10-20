import vm from 'node:vm';
import { JSDOM } from 'jsdom';
const BASE = 'http://127.0.0.1:3211';
const realFetch = globalThis.fetch;
const html = await (await realFetch(BASE + '/')).text();
const cleaned = html.replace(/<script[^>]*type="module"[^>]*><\/script>/gi, '');
const dom = new JSDOM(cleaned, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];
window.addEventListener('error', (e) => errors.push('window.error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason))));
const origErr = console.error.bind(console);
window.console = { ...console, error: (...a) => { errors.push('console.error: ' + a.map(String).join(' ')); origErr('[page]', ...a); }, log: () => {}, warn: () => {}, info: () => {} };
window.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('http') ? u : BASE + u, o);
window.EventSource = class { constructor(u) { this.url = u; this.readyState = 0; } addEventListener() {} close() {} };
window.confirm = () => false;
window.alert = () => {};
const parts = ['00-core.js','01-boot.js','02-sse-sessions.js','03-snowluma.js','04-archive-usage.js','05-memory-settings.js','06-settings-render.js','07-settings-events.js','08-modals.js','09-community.js','10-feedback.js','12-concept2-ui.js','13-qq-login.js','11-init.js'];
const ctx = vm.createContext(window);
for (const p of parts) {
  const src = await (await realFetch(`${BASE}/app/${p}`)).text();
  try { new vm.Script(src, { filename: p }).runInContext(ctx); }
  catch (e) { errors.push(`load ${p}: ${e.message}`); break; }
}
await new Promise(r => setTimeout(r, 6000));
const st = window.document.querySelector('#loading-status');
const ov = window.document.querySelector('#loading-overlay');
console.log('loading-status:', JSON.stringify(st && st.textContent));
console.log('overlay-present:', !!ov);
console.log('errors:', JSON.stringify(errors, null, 1));
process.exit(0);
