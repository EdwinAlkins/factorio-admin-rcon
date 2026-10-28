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

// The server's logs carry its public address ("Own address is IP
// ADDR:({90.12.…})"). Every public IPv4 the page shows is replaced by a
// documentation address (RFC 5737) as soon as it is drawn — before the first
// video frame, not only before a screenshot. Private and loopback ones are kept.
const REDACT = `
  (() => {
    const ipv4 = /\\b(\\d{1,3})\\.(\\d{1,3})\\.\\d{1,3}\\.\\d{1,3}\\b/g;
    const kept = (a, b) => a === '0' || a === '10' || a === '127' || (a === '192' && b === 168) || (a === '172' && b >= 16 && b <= 31);
    const scrub = (node) => {
      const text = node.nodeValue;
      const clean = text.replace(ipv4, (match, a, b) => (kept(a, Number(b)) ? match : '203.0.113.10'));
      if (clean !== text) node.nodeValue = clean;
    };
    const sweep = (root) => {
      if (root.nodeType === Node.TEXT_NODE) return scrub(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) scrub(node);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') scrub(record.target);
        for (const node of record.addedNodes) sweep(node);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
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
await ctx.addInitScript(REDACT);
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

// A tab exists only if its feature is on and the role may see it: against a
// minimal stack (no agents), these steps are skipped rather than failing.
async function openTab(label) {
  const tab = page.getByRole('button', { name: label, exact: true });
  if ((await tab.count()) === 0) {
    console.log(`skipped: no "${label}" tab on this panel`);
    return false;
  }
  await click(tab);
  await page.waitForLoadState('networkidle');
  await pause(1200);
  return true;
}

// The panel shown by the current tab, scrolled back to its top: tabs scroll
// inside the panel, not the page.
function panel(title) {
  return page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
}
async function scrollPanelTop(title) {
  await panel(title).locator(':scope > div').last().evaluate((el) => el.scrollTo(0, 0));
}

// Brings an element to the top of the panel it scrolls in, for a shot of the
// view: an element screenshot would be clipped by that scrolling panel.
async function scrollToTop(loc) {
  await loc.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
}

// Runs a preview and waits until its image is drawn: the button only reads
// "Preview" again once the game has answered.
async function renderPreview(button) {
  const answered = page.waitForResponse((r) => r.url().includes('/api/worlds/previews') && r.request().method() === 'POST', { timeout: 120000 });
  await click(button);
  await answered;
  await page.waitForFunction(() => {
    const img = document.querySelector('aside figure img');
    return img && img.complete && img.naturalWidth > 0 && !img.className.includes('opacity-50');
  }, null, { timeout: 60000 });
  await pause(1200);
}

// A folded section of a form, by its summary's text ("▸Resources").
const summary = (text) => page.locator('summary').filter({ hasText: new RegExp(`^▸?${text}`) }).first();

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

// ── 2. Console: three actions ──────────────────────────────────────────────
// A read, to fill the console.
await click(page.getByRole('button', { name: L.players, exact: true }));
await pause(900);
await shot('03-console');
await shot('04-quick-actions', page.locator('section').filter({ has: page.getByRole('heading', { level: 2 }) }).first());

// Asks for a confirmation and stops there: a dialog is shot, then cancelled.
async function cancelAtConfirmation(pageShot, dialogShot) {
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await shot(pageShot);
  await shot(dialogShot, page.getByRole('dialog'));
  await pause(1200);
  await click(page.getByRole('dialog').getByRole('button', { name: L.cancel }));
  await pause(300);
}

// A command typed by hand in the terminal.
const input = page.getByLabel(L.cmdLabel);
await click(input);
await input.type('/evolution', { delay: video ? 55 : 0 });
await pause(300);
await page.keyboard.press('Enter');
await pause(1100);
await shot('05-console-command');

// A moderation command, cancelled at its confirmation: nothing runs.
await click(page.getByRole('button', { name: L.kick }));
const playerField = page.getByLabel(L.playerLabel);
await click(playerField);
await playerField.type('griefer42', { delay: video ? 45 : 0 });
await click(page.getByRole('button', { name: L.send, exact: true }).first());
await cancelAtConfirmation('06-confirm-guard', '06b-confirm-dialog');

// ── 6. Audit log ───────────────────────────────────────────────────────────
await click(page.getByRole('button', { name: L.show }));
await page.waitForTimeout(1200);
await shot('07-audit', page, { fullPage: true });
await shot('08-audit-panel', page.locator('section').filter({ hasText: L.audit }).last());
await pause(1600);

// ── 7. Statistics ──────────────────────────────────────────────────────────
await click(page.getByRole('button', { name: L.metrics, exact: true }));
await page.waitForTimeout(2500);
await shot('09-metrics', page, { fullPage: true });
await shot('10-metrics-panel', page.locator('section').filter({ hasText: L.metrics }).last());
await pause(2200);

// ── 8. Server: state, settings, logs ───────────────────────────────────────
if (await openTab(L.server)) {
  await page.waitForTimeout(1500);
  await shot('11-server');
  // Folded by default: opened for its own shot. Nothing is saved.
  await click(summary(L.serverSettings));
  await page.waitForTimeout(1200);
  await scrollToTop(summary(L.serverSettings));
  await shot('12-server-settings');
  await click(summary(L.serverSettings));
  await scrollPanelTop(L.server);
  await pause(800);
}

// ── 9. Saves and mods (read only) ──────────────────────────────────────────
if (await openTab(L.saves)) {
  await shot('13-saves');
  await pause(1500);
}
// The Pyanodons suite in one go: its modpack is added, and the preview
// resolves every mod it needs into one plan. "Apply" is opened for the shot,
// then cancelled: it would replace the server's mods and convert its map.
if (await openTab(L.mods)) {
  const query = page.getByPlaceholder(L.modsSearch);
  if ((await query.count()) > 0) {
    await click(query);
    await query.type('Pyanodons', { delay: video ? 55 : 0 });
    const answered = page.waitForResponse((r) => r.url().includes('/api/mods/search'), { timeout: 60000 });
    await page.keyboard.press('Enter');
    await answered;
    await pause(1200);
    await shot('14-mods-search');

    // pymodpack is the official modpack: it depends on every mod of the
    // suite. Matched by its exact name, shown in monospace under the title.
    const hits = page.locator('li').filter({ has: page.getByRole('button', { name: L.modsAdd, exact: true }) });
    const named = (name) => hits.filter({ has: page.locator('span.font-mono', { hasText: new RegExp(`^${name}$`) }) });
    let target = named('pymodpack');
    if ((await target.count()) === 0) target = named('pyalternativeenergy');
    if ((await target.count()) === 0) target = hits;
    await click(target.first().getByRole('button', { name: L.modsAdd, exact: true }));
    const planned = page.waitForResponse((r) => r.url().includes('/api/mods/plan'), { timeout: 120000 });
    await click(page.getByRole('button', { name: L.modsPreview, exact: true }));
    await planned;
    await pause(1500);
    const apply = page.getByRole('button', { name: L.modsApply });
    await apply.scrollIntoViewIfNeeded();
    await pause(1200);
    await shot('15-mods-plan');
    if (await apply.isEnabled()) {
      await click(apply);
      await page.getByRole('dialog').waitFor({ timeout: 10000 });
      await page.waitForTimeout(500);
      await shot('15b-mods-apply-dialog', page.getByRole('dialog'));
      await pause(1500);
      await click(page.getByRole('dialog').getByRole('button', { name: L.cancel }));
    } else {
      console.log('note: the plan has conflicts, "Apply" is disabled');
    }
    await pause(800);
  } else {
    console.log('skipped: mod search needs factorio.com credentials (secrets/factorio-portal)');
    await shot('14-mods-search');
  }
}

// ── 10. Worlds: previews only ──────────────────────────────────────────────
// Previews run beside the server and write nothing. No world is created and
// "Put in play" is never clicked: it would replace the server's map.
if (await openTab(L.worlds)) {
  await click(summary(L.worldsCreator));
  // The first catalogue after a mod change dumps the game's data.
  const previewButton = page.getByRole('button', { name: L.preview, exact: true });
  await previewButton.waitFor({ timeout: 60000 });
  // A fixed seed: the published captures stay the same from run to run.
  const seed = page.locator('#world-seed');
  await click(seed);
  await seed.fill('');
  await seed.type('123456789', { delay: video ? 55 : 0 });
  await renderPreview(previewButton);
  await scrollPanelTop(L.worlds);
  await shot('16-worlds-preview');

  await click(summary(L.resources));
  const planets = page.getByRole('group', { name: L.planet });
  if ((await planets.count()) > 0) {
    // Space Age: another planet's resources, and its terrain.
    await click(planets.getByRole('button').nth(1));
    const select = page.locator('aside select').first();
    await select.selectOption({ index: 1 });
    await renderPreview(previewButton);
  }
  await scrollToTop(summary(L.resources));
  await shot('17-worlds-resources');

  await click(page.getByRole('button', { name: L.compare }));
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('aside .grid-cols-2 img')];
      return imgs.length === 4 && imgs.every((img) => img.complete && img.naturalWidth > 0);
    },
    null,
    { timeout: 120000 },
  );
  await pause(1500);
  await scrollPanelTop(L.worlds);
  await shot('18-worlds-compare');

  // The script creates no world: the library is shot only if it holds some.
  const library = page.getByRole('heading', { name: L.library, exact: true });
  if ((await page.locator('ul li img[src*="/preview"]').count()) > 0) {
    await click(summary(L.worldsCreator));
    await scrollToTop(library);
    await page.waitForFunction(() => [...document.querySelectorAll('ul li img')].every((img) => img.complete), null, { timeout: 30000 });
    await pause(1500);
    await shot('19-worlds-library');
  } else {
    console.log('skipped: 19-worlds-library, the library is empty (create a world in the panel first)');
  }
}

await click(page.getByRole('button', { name: L.console, exact: true }));
await pause(1200);

// ── 11. Mobile rendering ────────────────────────────────────────────────────
if (!video) {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(800);
  await shot('20-mobile', page, { fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

await ctx.close();
await browser.close();
console.log('done', MODE, LOCALE, '→', OUT);
