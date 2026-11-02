import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const tokens = () => JSON.parse(readFileSync('test-results/tokens.json', 'utf8'));
async function connect(page: Page, role: string) {
  await page.getByLabel('Access token', { exact: true }).fill(tokens()[role]);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('#status')).toContainText('demo-' + role);
}
async function capture(page: Page) {
  expect(
    await page
      .locator('[id]')
      .evaluateAll((nodes) => new Set(nodes.map((n) => n.id)).size === nodes.length),
  ).toBe(true);
  await page.getByLabel('Access token', { exact: true }).fill('');
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Disconnected');
}
test('complete operational workflow and responsive evidence dashboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await connect(page, 'operator');
  async function poll() {
    await page.waitForTimeout(550);
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/collect') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Collect observations', exact: true }).click();
    expect((await response).status()).toBe(200);
  }
  await poll();
  await expect(page.locator('#healthy-count')).toHaveText('3');
  await page.getByRole('button', { name: 'Interrupt directory', exact: true }).click();
  await poll();
  await poll();
  await expect(page.locator('#incident-count')).toHaveText('2');
  await expect(page.locator('#dependencies')).toContainText('investigate directory');
  await page.screenshot({ path: 'test-results/incident-drill.png', fullPage: true });
  await page
    .locator('#incident-note')
    .fill('Scripted local drill: inspected HTTP 503 and dependency evidence.');
  const ids = await page
    .locator('[data-incident-id]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-incident-id')));
  for (const id of ids) {
    const incident = page.locator(`[data-incident-id="${id}"]`);
    await incident.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    await incident.getByRole('button', { name: 'Start monitoring', exact: true }).click();
  }
  await page
    .locator('[data-incident-id]')
    .first()
    .getByRole('button', { name: 'Resolve with fresh evidence', exact: true })
    .click();
  await expect(page.locator('#notice')).toContainText('two_fresh_successful_observations_required');
  await page.getByRole('button', { name: 'Restore lab services', exact: true }).click();
  await poll();
  await poll();
  for (const id of ids)
    await page
      .locator(`[data-incident-id="${id}"]`)
      .getByRole('button', { name: 'Resolve with fresh evidence', exact: true })
      .click();
  await expect(page.locator('#incident-count')).toHaveText('0');
  await page.getByRole('button', { name: 'Create signed backup', exact: true }).click();
  await page.locator('summary').click();
  await page.getByRole('button', { name: 'Record objective change', exact: true }).click();
  await connect(page, 'requester');
  await page.getByRole('button', { name: 'Plan restore', exact: true }).click();
  await expect(page.locator('#plans .record')).toHaveCount(1);
  await connect(page, 'reviewer');
  await page.locator('#plans').getByRole('button', { name: 'Approve', exact: true }).click();
  await connect(page, 'operator');
  await page.locator('#plans').getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.locator('#plans header .badge')).toHaveText('completed');
  const download = page.waitForEvent('download');
  await page
    .locator('[data-incident-id]')
    .first()
    .getByRole('button', { name: 'Export investigation', exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe('investigation.json');
  await capture(page);
  expect(errors).toEqual([]);
});
