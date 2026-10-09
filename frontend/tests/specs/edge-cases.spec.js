const { test } = require('node:test');
const path = require('node:path');
const { createRequire } = require('node:module');
const bcrypt = createRequire(path.join(__dirname, '../../../backend/package.json'))('bcrypt');
const env = require('../support/environment');
const { assert, accounts, createPage, dateOffset } = env;
const { signIn } = require('../commands/auth');

// The demo employee enables 2FA in an earlier spec, so edge cases use their own password-only employee.
const edgeEmployee = { email: 'edge.employee@example.test', password: 'EdgeEmployee123!', home: 'employee.html' };

let edgeEmployeeSeeded = false;
function seedEdgeEmployee() {
  if (edgeEmployeeSeeded) return edgeEmployee;
  env.fixtureDb.prepare("INSERT INTO users (name, email, password_hash, role, department, email_verified_at) VALUES (?, ?, ?, 'employee', 'Housekeeping', datetime('now'))")
    .run('Edgar Edge', edgeEmployee.email, bcrypt.hashSync(edgeEmployee.password, 4));
  const id = env.fixtureDb.prepare('SELECT id FROM users WHERE email = ?').get(edgeEmployee.email).id;
  env.fixtureDb.prepare('INSERT OR IGNORE INTO leave_balances (user_id) VALUES (?)').run(id);
  edgeEmployeeSeeded = true;
  return edgeEmployee;
}

test('login shows server-unreachable, validation, lockout, and 2FA-retry states', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));

  await page.goto(`${env.frontendBase}/index.html`);
  await page.locator('#email').fill(accounts.employee.email);
  await page.locator('#password').fill(accounts.employee.password);
  await page.route('**/auth/login', (route) => route.abort());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#loginError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#loginError').innerText(), /Could not reach the server/i);
  await page.unroute('**/auth/login');

  await page.route('**/auth/login', (route) => route.fulfill({
    status: 423,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Account temporarily locked. Try again in 15 minute(s).' }),
  }));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#loginError').getByText(/temporarily locked/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign in' }).isEnabled(), true);
  await page.unroute('**/auth/login');

  await page.route('**/auth/login', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'TWO_FACTOR_REQUIRED', challenge: 'abc', error: 'Two-factor authentication is required' }),
  }));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#otpField:not(.hidden)').waitFor();
  assert.match(await page.locator('#loginError').innerText(), /6-digit code/i);
});

test('forgot-password toggles, reset and invite links with bad tokens report errors', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));

  await page.goto(`${env.frontendBase}/index.html`);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.locator('#forgotPasswordForm:not(.hidden)').waitFor();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.locator('#forgotPasswordForm.hidden').waitFor({ state: 'attached' });

  const badToken = 'a'.repeat(64);
  await page.goto(`${env.frontendBase}/index.html?reset=${badToken}`);
  await page.locator('#resetForm').waitFor();
  assert.match(await page.locator('#formTitle').innerText(), /Set new password/);
  await page.locator('#resetPassword').fill('Replacement123!');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await page.locator('#loginError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#loginError').innerText(), /invalid or expired/i);
  assert.equal(await page.locator('#resetForm').isVisible(), true);

  await page.goto(`${env.frontendBase}/index.html?invite=${badToken}`);
  await page.locator('#inviteForm').waitFor();
  assert.match(await page.locator('#formTitle').innerText(), /Create account/);
  await page.locator('#firstName').fill('Nova');
  await page.locator('#familyName').fill('Invalid');
  await page.locator('#businessId').fill('BAD-INV-01');
  await page.locator('#signupPhone').fill('+15555550199');
  await page.locator('#signupPassword').fill('BadInvite123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('#loginError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#loginError').innerText(), /invalid or expired/i);

  await page.goto(`${env.frontendBase}/verify-email.html?token=${badToken}`);
  await page.locator('#status').getByText(/invalid or expired/i).waitFor();
});

test('protected pages redirect when the session is gone and signed-in users skip login', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));

  await page.goto(`${env.frontendBase}/employee.html`);
  await page.waitForURL('**/index.html');
  await page.goto(`${env.frontendBase}/admin.html`);
  await page.waitForURL('**/index.html');

  await signIn(page, 'manager');
  await page.goto(`${env.frontendBase}/index.html`);
  await page.waitForURL('**/manager.html');

  await page.goto(`${env.frontendBase}/admin.html`);
  await page.waitForURL('**/manager.html');
  await page.goto(`${env.frontendBase}/employee.html`);
  await page.locator('#userName').getByText('Maria Manager').waitFor();
});

test('an expired access token is silently refreshed and a failed refresh signs the user out', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await signIn(page, 'employee', seedEdgeEmployee());

  let expiredOnce = false;
  await page.route('**/shifts/mine', (route) => {
    if (expiredOnce) return route.continue();
    expiredOnce = true;
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Access token expired', code: 'TOKEN_EXPIRED' }),
    });
  });
  await page.reload();
  await page.locator('#historyEmpty:not(.hidden)').waitFor();
  assert.equal(expiredOnce, true);
  await page.locator('#userName').getByText('Edgar Edge').waitFor();
  await page.unroute('**/shifts/mine');

  await page.route('**/auth/me', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Invalid access token' }),
  }));
  await page.reload();
  await page.waitForURL('**/index.html');
});

test('employee page shows motion support, empty states, and server-side validation errors', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await signIn(page, 'employee', seedEdgeEmployee());

  await page.locator('#startActivity').click();
  await page.locator('#startActivity').getByText('Motion tracking on').waitFor();
  await page.evaluate(() => {
    const event = new Event('devicemotion');
    event.accelerationIncludingGravity = { x: 10, y: 10, z: 10 };
    window.dispatchEvent(event);
    const empty = new Event('devicemotion');
    window.dispatchEvent(empty);
  });
  await page.locator('#activitySummary').getByText(/estimated steps/).waitFor();
  await page.locator('#startActivity').click();

  await page.addInitScript(() => { Object.defineProperty(window, 'DeviceMotionEvent', { value: undefined, configurable: true }); });
  await page.reload();
  await page.locator('#startActivity').click();
  await page.locator('#activitySummary').getByText(/not supported/).waitFor();

  await page.addInitScript(() => {
    window.DeviceMotionEvent = function DeviceMotionEvent() {};
    window.DeviceMotionEvent.requestPermission = async () => 'denied';
  });
  await page.reload();
  await page.locator('#startActivity').click();
  await page.locator('#activitySummary').getByText(/permission was not granted/).waitFor();

  await page.locator('#feedbackDate').fill(dateOffset(-400));
  await page.locator('#feedbackForms').getByText('No completed shift on this date yet.').waitFor();

  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.locator('#scheduleDateFilter').fill(dateOffset(300));
  await page.locator('#scheduleEmpty:not(.hidden)').waitFor();
  await page.locator('#unavailableDate').fill(dateOffset(40));
  await page.getByRole('button', { name: 'Add unavailable date' }).click();
  await page.locator('#unavailableBody').getByText(dateOffset(40)).waitFor();
  await page.locator('#unavailableDate').fill(dateOffset(40));
  await page.getByRole('button', { name: 'Add unavailable date' }).click();
  await page.locator('#unavailableError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#unavailableError').innerText(), /already marked unavailable/i);
  await page.locator('#unavailableBody').getByRole('button', { name: 'Remove' }).first().click();

  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await page.locator('#leaveStart').fill(dateOffset(70));
  await page.locator('#leaveEnd').fill(dateOffset(60));
  await page.getByRole('button', { name: 'Request sick leave' }).click();
  await page.locator('#leaveError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#leaveError').innerText(), /valid leave date range/i);

  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.locator('#manualClockIn').fill(`${dateOffset(-5)}T17:00`);
  await page.locator('#manualClockOut').fill(`${dateOffset(-5)}T09:00`);
  await page.locator('#manualReason').fill('Backwards range');
  await page.getByRole('button', { name: 'Request correction' }).click();
  await page.locator('#requestError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#requestError').innerText(), /valid time range/i);

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.locator('#twoFactorCode').waitFor({ state: 'attached' });
  await page.locator('#profilePhone').fill('x'.repeat(41));
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.locator('#profileSuccess.alert-hidden').waitFor({ state: 'attached' });
});

test('employee clock action surfaces server errors', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await signIn(page, 'employee', seedEdgeEmployee());

  const clockButton = page.locator('#clockBtn');
  await page.route('**/shifts/clock-in', (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'You are already clocked in' }),
  }));
  await clockButton.click();
  await page.locator('#clockError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#clockError').innerText(), /already clocked in/i);
  await page.unroute('**/shifts/clock-in');

  await page.route('**/open-shifts/*/claim', (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'This open shift was claimed or conflicts with your schedule' }),
  }));
  const managerPage = await env.createTrackedPage(await env.createContext());
  await signIn(managerPage, 'manager');
  await managerPage.getByRole('button', { name: 'Schedule', exact: true }).click();
  await managerPage.locator('#openShiftDate').fill(dateOffset(90));
  await managerPage.locator('#openShiftStart').fill('10:00');
  await managerPage.locator('#openShiftEnd').fill('14:00');
  await managerPage.locator('#openShiftNote').fill('Conflict claim shift');
  await managerPage.getByRole('button', { name: 'Post open shift' }).click();
  await managerPage.waitForResponse((response) => response.url().includes('/open-shifts') && response.request().method() === 'POST');
  await env.closePage(managerPage);

  await page.reload();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const dialogMessage = new Promise((resolve) => {
    page.once('dialog', async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
  await page.locator('#openShiftsBody > div').filter({ hasText: 'Conflict claim shift' }).getByRole('button', { name: 'Claim' }).click();
  assert.match(await dialogMessage, /claimed or conflicts/);
  await page.locator('#openShiftsBody').getByText('Conflict claim shift').waitFor();
});
