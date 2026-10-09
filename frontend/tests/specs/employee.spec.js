const { test } = require('node:test');
const env = require('../support/environment');
const { assert, crypto, accounts, createPage, dateOffset, localDateTimeOffset, totpCode } = env;
const { signIn } = require('../commands/auth');

test('employee completes shift, leave, availability, correction, report, profile, security, and open-shift flows', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await signIn(page, 'employee');

  await page.getByRole('button', { name: 'Clock in' }).click();
  await page.getByRole('button', { name: 'Clock out' }).waitFor();
  assert.match(await page.locator('#statusText').innerText(), /clocked in/i);
  await page.getByRole('button', { name: 'Start break' }).click();
  await page.getByRole('button', { name: 'End break' }).waitFor();
  await page.getByRole('button', { name: 'End break' }).click();
  await page.getByRole('button', { name: 'Start break' }).waitFor();
  await page.locator('#clockOutNote').fill('Frontend test, "quoted" shift');
  await page.getByRole('button', { name: 'Clock out' }).click();
  await page.getByRole('button', { name: 'Clock in' }).waitFor();
  assert.ok(env.fixtureDb.prepare("SELECT id FROM time_entries WHERE user_id = (SELECT id FROM users WHERE email = 'employee@demo.local') AND note = ?").get('Frontend test, "quoted" shift'));

  await page.locator('#feedbackDate').fill(await page.evaluate(() => new Date().toLocaleDateString('en-CA')));
  await page.locator('#feedbackForms .feedback-form').waitFor();
  await page.locator('#feedbackForms select[name="rating"]').selectOption('5');
  await page.locator('#feedbackForms input[name="comment"]').fill('Frontend feedback');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await page.getByRole('button', { name: 'Update feedback' }).waitFor();

  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.locator('#openShiftsBody').getByText('Claimable UI test shift').waitFor();
  await page.locator('#openShiftsBody > div').filter({ hasText: 'Claimable UI test shift' }).getByRole('button', { name: 'Claim' }).click();
  await page.locator('#openShiftsBody').getByText('No open shifts.').waitFor();

  const unavailableDate = dateOffset(25);
  await page.locator('#unavailableDate').fill(unavailableDate);
  await page.locator('#unavailableNote').fill('Frontend unavailable date');
  await page.getByRole('button', { name: 'Add unavailable date' }).click();
  await page.locator('#unavailableBody').getByText(unavailableDate).waitFor();
  await page.locator('#unavailableBody').getByRole('button', { name: 'Remove' }).click();
  await page.locator('#unavailableBody').getByText('No unavailable dates selected.').waitFor();

  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await page.locator('#leaveStart').fill(dateOffset(30));
  await page.locator('#leaveEnd').fill(dateOffset(31));
  await page.locator('#leaveNote').fill('Frontend leave request');
  await page.getByRole('button', { name: 'Request sick leave' }).click();
  await page.locator('#leaveBody').getByText('pending').waitFor();
  await page.locator('#leaveBalance').getByText(/days remaining/).waitFor();

  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  await page.locator('#manualClockIn').fill(localDateTimeOffset(-2, '09:00'));
  await page.locator('#manualClockOut').fill(localDateTimeOffset(-2, '17:00'));
  await page.locator('#manualReason').fill('Frontend missed punch correction');
  await page.getByRole('button', { name: 'Request correction' }).click();
  await page.locator('#requestSuccess:not(.alert-hidden)').waitFor();
  await page.locator('#requestsBody').getByText('pending').waitFor();

  await page.locator('#category').selectOption('ergonomics');
  await page.locator('#description').fill('The supply cart handle needs repair.');
  await page.locator('#reportAnonymous').check();
  await page.getByRole('button', { name: 'Send to manager' }).click();
  await page.locator('#reportSuccess:not(.alert-hidden)').waitFor();
  await page.locator('#myReportsBody').getByText('ergonomics').waitFor();

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.locator('#profilePhone').fill('+15555550126');
  await page.locator('#profileBusinessId').fill('UI-EMP-42');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.locator('#profileSuccess:not(.alert-hidden)').waitFor();
  await page.locator('#setupTwoFactor').click();
  await page.locator('#twoFactorSecret').waitFor();
  const secret = await page.locator('#twoFactorSecret').innerText();
  await page.locator('#twoFactorCode').fill('000000');
  await page.locator('#enableTwoFactor').click();
  await page.locator('#securitySuccess:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#securitySuccess').innerText(), /invalid/i);
  await page.locator('#twoFactorCode').fill(totpCode(secret));
  await page.locator('#enableTwoFactor').click();
  await page.locator('#twoFactorSetup.hidden').waitFor({ state: 'attached' });
  assert.match(await page.locator('#securitySuccess').innerText(), /enabled/i);
  await page.locator('#requestNotificationPermission').click();
  await page.locator('#requestNotificationPermission').getByText(/Notifications:/).waitFor();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Shift', exact: true }).click();
  await page.getByRole('button', { name: 'Clock in' }).click();
  await page.getByRole('button', { name: 'Clock out' }).waitFor();
  assert.match(await page.locator('#syncStatus').innerText(), /Offline/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('shiftOfflineQueue')).length), 1);
  await page.getByRole('button', { name: 'Clock out' }).click();
  await page.getByRole('button', { name: 'Clock in' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('shiftOfflineQueue')).length), 2);
  await context.setOffline(false);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('shiftOfflineQueue')).length === 0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/index.html');
  await page.locator('#email').fill(accounts.employee.email);
  await page.locator('#password').fill(accounts.employee.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#otpField:not(.hidden)').waitFor();
  await page.locator('#otp').fill(totpCode(secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/employee.html');
});

