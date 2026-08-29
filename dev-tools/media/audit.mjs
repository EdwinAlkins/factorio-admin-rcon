import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { BASE, PW, LOCALE, OUT, BROWSER_LOCALE, L } from './config.mjs';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1000, height: 900 },   // < lg (1024px): the grid stacks
  deviceScaleFactor: 2,
  locale: BROWSER_LOCALE,
  colorScheme: 'dark',
});
const page = await ctx.newPage();
await page.goto(`${BASE}/${LOCALE}/login`, { waitUntil: 'networkidle' });
await page.fill('#password', PW);
await page.getByRole('button', { name: L.login }).click();
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 25000 });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500);
await page.getByRole('button', { name: L.show }).click();
await page.waitForTimeout(1500);

const section = page.locator('section').filter({ hasText: L.audit }).last();
await section.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await section.screenshot({ path: `${OUT}/09-audit-panel.png`, animations: 'disabled' });

await ctx.close();
await browser.close();
console.log('audit ok', LOCALE, '→', OUT);
