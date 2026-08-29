import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { BASE, PW, LOCALE, MODE, OUT, BROWSER_LOCALE, L } from './config.mjs';

// Fake cursor: Playwright does not record the system pointer.
const CURSOR = `
  (() => {
    const install = () => {
      if (document.getElementById('__cur')) return;
      const d = document.createElement('div');
      d.id = '__cur';
      d.style.cssText = 'position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;' +
        'border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 12px rgba(255,255,255,.5);' +
        'pointer-events:none;left:-100px;top:-100px;transition:transform .08s ease-out';
      document.documentElement.appendChild(d);
      addEventListener('mousemove', e => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
      addEventListener('mousedown', () => {
        d.style.transform = 'scale(.6)';
        const r = document.createElement('div');
        r.style.cssText = 'position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
          'border:2px solid rgba(245,164,66,.9);pointer-events:none;left:' + d.style.left + ';top:' + d.style.top + ';' +
          'transition:all .45s ease-out';
        document.documentElement.appendChild(r);
        requestAnimationFrame(() => { r.style.width='52px'; r.style.height='52px'; r.style.margin='-26px 0 0 -26px'; r.style.opacity='0'; });
        setTimeout(() => r.remove(), 500);
      }, true);
      addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; }, true);
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install);
    else install();
    new MutationObserver(install).observe(document.documentElement, { childList: true });
  })();
`;

const video = MODE === 'video';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: video ? 1 : 2,
  locale: BROWSER_LOCALE,
  colorScheme: 'dark',
  reducedMotion: 'no-preference',
  ...(video ? { recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } } : {}),
});
if (video) await ctx.addInitScript(CURSOR);
const page = await ctx.newPage();

const pause = (ms) => page.waitForTimeout(video ? ms : Math.min(ms, 250));

async function moveTo(loc) {
  const box = await loc.boundingBox();
  if (!video) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 26 });
}
async function click(loc) {
  await loc.scrollIntoViewIfNeeded();
  await moveTo(loc);
  await pause(220);
  await loc.click();
  await pause(500);
}
async function shot(name, target = page, opts = {}) {
  if (video) return;
  if (target === page) await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  await target.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', ...opts });
}

// ── 1. Sign-in ─────────────────────────────────────────────────────────────
await page.goto(`${BASE}/${LOCALE}/login`, { waitUntil: 'networkidle' });
await pause(900);
await shot('01-login');

await click(page.locator('#password'));
await page.locator('#password').type(PW, { delay: video ? 55 : 0 });
await pause(500);
await click(page.getByRole('button', { name: L.login }));
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 25000 });
await page.waitForLoadState('networkidle');
await pause(1400);
await shot('02-panel');

// ── 2. Read-only quick actions ─────────────────────────────────────────────
for (const label of [L.players, L.version, L.evolution]) {
  await click(page.getByRole('button', { name: label, exact: true }));
  await pause(1100);
}
await shot('03-console');
await shot('04-quick-actions', page.locator('section').filter({ has: page.getByRole('heading', { level: 2 }) }).first());

// ── 3. Hand-typed command ──────────────────────────────────────────────────
const input = page.getByLabel(L.cmdLabel);
await click(input);
await input.type('/players online', { delay: video ? 55 : 0 });
await pause(400);
await page.keyboard.press('Enter');
await pause(1300);
await shot('05-console-command');

// ── 4. Lua guard (cancelled, nothing runs) ─────────────────────────────────
await click(input);
await input.type('/c game.print("hello")', { delay: video ? 50 : 0 });
await pause(400);
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
await shot('06-lua-guard');
await shot('06b-lua-dialog', page.getByRole('dialog'));
await pause(1400);
await click(page.getByRole('dialog').getByRole('button', { name: L.cancel }));

// ── 5. Destructive-action confirmation (cancelled too) ─────────────────────
await click(page.getByRole('button', { name: L.kick }));
await pause(400);
const playerField = page.getByLabel(L.playerLabel);
await click(playerField);
await playerField.type('griefer42', { delay: video ? 55 : 0 });
await pause(300);
await click(page.getByRole('button', { name: L.send, exact: true }).first());
await page.waitForTimeout(700);
await shot('07-confirm-guard');
await shot('07b-confirm-dialog', page.getByRole('dialog'));
await pause(1500);
await click(page.getByRole('dialog').getByRole('button', { name: L.cancel }));
await pause(400);

// ── 6. Audit log ───────────────────────────────────────────────────────────
await click(page.getByRole('button', { name: L.show }));
await page.waitForTimeout(1200);
await shot('08-audit', page, { fullPage: true });
await shot('09-audit-panel', page.locator('section').filter({ hasText: L.audit }).last());
await pause(1600);

// ── 7. Statistics ──────────────────────────────────────────────────────────
await click(page.getByRole('button', { name: L.metrics, exact: true }));
await page.waitForTimeout(2500);
await shot('10-metrics', page, { fullPage: true });
await shot('11-metrics-panel', page.locator('section').filter({ hasText: L.metrics }).last());
await pause(2200);
await click(page.getByRole('button', { name: L.console, exact: true }));
await pause(1200);

// ── 8. Mobile rendering ────────────────────────────────────────────────────
if (!video) {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(800);
  await shot('12-mobile', page, { fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

await ctx.close();
await browser.close();
console.log('done', MODE, LOCALE, '→', OUT);
