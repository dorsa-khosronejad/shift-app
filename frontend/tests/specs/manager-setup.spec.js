const { test } = require('node:test');
const env = require('../support/environment');
const { assert, crypto, accounts, createPage, dateOffset, localDateTimeOffset, totpCode } = env;
const { signIn } = require('../commands/auth');

test('manager can create schedules and open shifts, edit targets, and download reports', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await signIn(page, 'manager');

  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.locator('#scheduleEmployee').selectOption({ label: 'Elina Employee' });
  const managerScheduleDate = dateOffset(8);
  await page.locator('#scheduleDate').fill(managerScheduleDate);
  await page.locator('#scheduleStart').fill('08:00');
  await page.locator('#scheduleEnd').fill('16:00');
  await page.locator('#scheduleNote').fill('Created through manager UI');
  await page.getByRole('button', { name: 'Add to schedule' }).click();
  await page.locator('#scheduleBody').getByText('Created through manager UI').waitFor();

  await page.locator('#scheduleDate').fill(managerScheduleDate);
  await page.locator('#scheduleStart').fill('09:00');
  await page.locator('#scheduleEnd').fill('12:00');
  await page.getByRole('button', { name: 'Add to schedule' }).click();
  await page.locator('#scheduleError:not(.alert-hidden)').waitFor();
  assert.match(await page.locator('#scheduleError').innerText(), /overlapping shift/i);

  await page.locator('#openShiftDate').fill(dateOffset(12));
  await page.locator('#openShiftStart').fill('17:00');
  await page.locator('#openShiftEnd').fill('21:00');
  await page.locator('#openShiftNote').fill('Claimable UI test shift');
  await page.getByRole('button', { name: 'Post open shift' }).click();
  await page.locator('#openShiftNote').waitFor();
  const openShiftId = env.fixtureDb.prepare("SELECT id FROM open_shifts WHERE note = 'Claimable UI test shift' ORDER BY id DESC LIMIT 1").get()?.id;
  assert.ok(openShiftId);

  const employeeId = env.fixtureDb.prepare("SELECT id FROM users WHERE email = 'employee@demo.local'").get().id;
  const targetInput = page.locator(`[data-target-user="${employeeId}"]`);
  const targetUpdate = page.waitForResponse((response) => response.url().includes(`/shifts/targets/${employeeId}`) && response.request().method() === 'PUT');
  await targetInput.fill('36');
  await targetInput.dispatchEvent('change');
  assert.equal((await targetUpdate).status(), 200);
  assert.equal(env.fixtureDb.prepare('SELECT target_hours FROM weekly_targets WHERE user_id = ?').get(employeeId).target_hours, 36);

  await page.getByRole('button', { name: 'Payroll', exact: true }).click();
  const [payrollDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  assert.equal(payrollDownload.suggestedFilename(), 'shift-payroll-export.csv');

  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.locator('#loadReportsButton').click();
  await page.locator('#hoursReportBody').waitFor();
  const [reportsDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#downloadReportsCsv').click(),
  ]);
  assert.match(reportsDownload.suggestedFilename(), /^shift-report-.*\.csv$/);

  await page.locator('#printReportsPdf').click();
  await page.waitForFunction(() => window.__printWasCalled === true);
  assert.equal(await page.locator('#hoursReportBody').isVisible(), true);
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.locator('#dashboardDetails').getByText('Today at a glance').waitFor();
});

