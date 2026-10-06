const { test } = require('node:test');
const env = require('../support/environment');
const { assert, createPage, createContext } = env;
const { signIn } = require('../commands/auth');

test('admin sees validation errors for staff and invite creation and can copy invite links', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.frontendBase });
  await signIn(page, 'admin');

  await page.getByRole('button', { name: 'Add staff member', exact: true }).click();
  await page.locator('#name').fill('Duplicate Staff');
  await page.locator('#email').fill('employee@demo.local');
  await page.locator('#password').fill('Duplicate123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('#createError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#createError').innerText(), /already exists/i);

  await page.getByRole('button', { name: 'Invite links', exact: true }).click();
  await page.route('**/auth/invites', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Enter a valid email and role' }) });
  });
  await page.locator('#inviteEmail').fill('rejected.invite@example.test');
  await page.getByRole('button', { name: 'Generate invite link' }).click();
  await page.locator('#inviteError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#inviteError').innerText(), /valid email/i);
  await page.unroute('**/auth/invites');

  await page.locator('#inviteEmail').fill('copied.invite@example.test');
  await page.getByRole('button', { name: 'Generate invite link' }).click();
  await page.locator('#inviteLinkBox:not(.hidden)').waitFor();
  await page.getByRole('button', { name: 'Copy link' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /index\.html\?invite=[a-f0-9]{64}/);
  await page.locator('#invitesBody').getByText('copied.invite@example.test').waitFor();
  await page.locator('#invitesBody').getByText('Pending').first().waitFor();
});

test('the service worker precaches the app shell and serves it when the network is down', async (t) => {
  const context = await createContext({ allowServiceWorkers: true });
  await t.after(() => env.closeContext(context));
  const page = await env.createTrackedPage(context);

  await page.goto(`${env.frontendBase}/index.html`);
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await page.evaluate(async () => (await (await caches.open('shift-care-v1')).keys()).map((request) => new URL(request.url).pathname));
  assert.ok(cached.includes('/index.html'));
  assert.ok(cached.includes('/js/api.js'));

  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  const offline = await page.evaluate(async () => {
    const response = await fetch('/index.html');
    return { ok: response.ok, text: (await response.text()).includes('Sign in') };
  });
  assert.equal(offline.ok, true);
  assert.equal(offline.text, true);
  await context.setOffline(false);

  const ignoredPost = await page.evaluate(async (api) => {
    try { await fetch(`${api}/ready`, { method: 'POST' }); return 'responded'; } catch { return 'failed'; }
  }, env.apiBase);
  assert.ok(['responded', 'failed'].includes(ignoredPost));

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.active.postMessage('noop');
  });
});
