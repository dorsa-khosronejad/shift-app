const { test } = require('node:test');
const env = require('../support/environment');
const { assert, crypto, accounts, createPage, dateOffset, localDateTimeOffset, totpCode } = env;
const { signIn } = require('../commands/auth');

test('sign-in, role routing, and protected-page redirects work in a real browser', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));

  await page.goto(`${env.frontendBase}/index.html`);
  await page.locator('#email').fill(accounts.employee.email);
  await page.locator('#password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#loginError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#loginError').innerText(), /Incorrect email or password/i);

  await page.locator('#password').fill(accounts.employee.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/employee.html');
  await page.locator('#userName').getByText('Elina Employee').waitFor();

  await page.goto(`${env.frontendBase}/manager.html`);
  await page.waitForURL('**/employee.html');
  assert.equal(new URL(page.url()).pathname.endsWith('/employee.html'), true);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/index.html');
  assert.equal(await page.locator('#email').isVisible(), true);
});

