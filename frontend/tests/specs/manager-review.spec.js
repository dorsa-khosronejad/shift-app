const { test } = require('node:test');
const env = require('../support/environment');
const { assert, crypto, accounts, createPage, dateOffset, localDateTimeOffset, totpCode } = env;
const { signIn } = require('../commands/auth');

test('manager approves employee requests and resolves anonymous reports in the UI', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await signIn(page, 'manager');

  await page.getByRole('button', { name: 'Approvals', exact: true }).click();
  const correctionRow = page.locator('#requestsBody tr').filter({ hasText: 'Frontend missed punch correction' });
  await correctionRow.getByRole('button', { name: 'Approve' }).click();
  await correctionRow.getByText('approved').waitFor();

  const employeeId = env.fixtureDb.prepare("SELECT id FROM users WHERE email = 'employee@demo.local'").get().id;
  const leaveRow = page.locator('#leaveBody tr').filter({ hasText: 'Frontend leave request' });
  await leaveRow.getByRole('button', { name: 'Approve' }).click();
  await leaveRow.getByText('approved').waitFor();

  await page.getByRole('button', { name: 'Team', exact: true }).click();
  const reportDescription = 'The supply cart handle needs repair.';
  const reportRow = page.locator('#reportsBody tr').filter({ hasText: reportDescription });
  await reportRow.locator('.followup-input').fill('Maintenance ticket opened.');
  await reportRow.getByRole('button', { name: 'Acknowledge' }).click();
  await reportRow.getByRole('button', { name: 'Resolve' }).waitFor();
  await reportRow.locator('.followup-input').fill('The cart was repaired.');
  await reportRow.getByRole('button', { name: 'Resolve' }).click();
  await reportRow.getByText('resolved', { exact: true }).waitFor();
  await assert.rejects(reportRow.getByRole('button', { name: 'Resolve' }).waitFor({ timeout: 250 }));

  const reviewedLeave = env.fixtureDb.prepare("SELECT status FROM sick_leave_requests WHERE user_id = ? AND note = 'Frontend leave request'").get(employeeId);
  assert.equal(reviewedLeave.status, 'approved');
  const reviewedCorrection = env.fixtureDb.prepare("SELECT status FROM shift_requests WHERE user_id = ? AND reason = 'Frontend missed punch correction'").get(employeeId);
  assert.equal(reviewedCorrection.status, 'approved');
  const reviewedReport = env.fixtureDb.prepare("SELECT status, manager_response FROM wellbeing_reports WHERE user_id = ? AND description = ?").get(employeeId, reportDescription);
  assert.equal(reviewedReport.status, 'resolved');
  assert.equal(reviewedReport.manager_response, 'The cart was repaired.');

  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const scheduledRow = page.locator('#scheduleBody tr').filter({ hasText: 'Created through manager UI' });
  await scheduledRow.getByRole('button', { name: 'Remove' }).click();
  await scheduledRow.waitFor({ state: 'detached' });
});

