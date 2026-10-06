const { test } = require('node:test');
const env = require('../support/environment');
const { assert, crypto, accounts, createPage, dateOffset, localDateTimeOffset, totpCode } = env;
const { signIn } = require('../commands/auth');

test('admin creates staff and invites; public invite, reset, and verification pages handle success and failure', async (t) => {
  const { context, page } = await createPage();
  await t.after(() => env.closeContext(context));
  await signIn(page, 'admin');

  const createdEmail = 'frontend.created@example.test';
  await page.getByRole('button', { name: 'Add staff member', exact: true }).click();
  await page.locator('#name').fill('Frontend Created');
  await page.locator('#email').fill(createdEmail);
  await page.locator('#department').fill('Front Desk');
  await page.locator('#role').selectOption('employee');
  await page.locator('#password').fill('Created123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('#createSuccess:not(.alert-hidden)').waitFor();

  await page.getByRole('button', { name: 'Staff accounts', exact: true }).click();
  const createdId = env.fixtureDb.prepare('SELECT id FROM users WHERE email = ?').get(createdEmail).id;
  const accountRow = page.locator('#usersBody tr').filter({ hasText: createdEmail });
  await accountRow.locator(`select[data-role-id="${createdId}"]`).selectOption('manager');
  await page.waitForFunction((id) => document.querySelector(`#usersBody select[data-role-id="${id}"]`)?.value === 'manager', createdId);
  await accountRow.getByRole('button', { name: 'Deactivate' }).click();
  await accountRow.getByText('Deactivated').waitFor();
  await accountRow.getByRole('button', { name: 'Approve / reactivate' }).click();
  await accountRow.getByText('Active').waitFor();
  assert.equal(env.fixtureDb.prepare('SELECT role FROM users WHERE id = ?').get(createdId).role, 'manager');

  await page.getByRole('button', { name: 'Invite links', exact: true }).click();
  const inviteEmail = 'frontend.invited@example.test';
  await page.locator('#inviteEmail').fill(inviteEmail);
  await page.locator('#inviteDepartment').fill('Night Audit');
  await page.locator('#inviteRole').selectOption('employee');
  await page.getByRole('button', { name: 'Generate invite link' }).click();
  await page.locator('#inviteSuccess:not(.alert-hidden)').waitFor();
  const inviteLink = await page.locator('#inviteLinkOutput').inputValue();
  const invitePage = await env.createTrackedPage(context);
  await invitePage.goto(inviteLink);
  await invitePage.locator('#inviteForm').waitFor();
  await invitePage.locator('#firstName').fill('Indigo');
  await invitePage.locator('#familyName').fill('Invite');
  await invitePage.locator('#businessId').fill('FRONT-INV-01');
  await invitePage.locator('#signupPhone').fill('+15555550127');
  await invitePage.locator('#signupPassword').fill('InviteFlow123!');
  await invitePage.getByRole('button', { name: 'Create account' }).click();
  await invitePage.locator('#signupSuccess:not(.alert-hidden)').waitFor();
  assert.equal(env.fixtureDb.prepare('SELECT role FROM users WHERE email = ?').get(inviteEmail).role, 'employee');
  assert.equal((await invitePage.locator('#inviteForm').isVisible()), false);
  await env.closePage(invitePage);

  await page.reload();
  await page.waitForURL('**/admin.html');
  await page.getByRole('button', { name: 'Audit log', exact: true }).click();
  await page.locator('#auditBody').getByText('invite-created').waitFor();
  await page.locator('#auditBody').getByText('invite-accepted').waitFor();

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetHash = crypto.createHash('sha256').update(resetToken).digest('hex');
  env.fixtureDb.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    createdId,
    resetHash,
    new Date(Date.now() + 60000).toISOString()
  );
  const resetPage = await env.createTrackedPage(context);
  await resetPage.goto(`${env.frontendBase}/index.html?reset=${resetToken}`);
  await resetPage.locator('#resetForm').waitFor();
  await resetPage.locator('#resetPassword').fill('ResetFrontend123!');
  await resetPage.getByRole('button', { name: 'Set new password' }).click();
  await resetPage.locator('#loginError:not(.alert-hidden)').waitFor();
  assert.match(await resetPage.locator('#loginError').innerText(), /reset successfully/i);
  assert.equal((await fetch(`${env.apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: createdEmail, password: 'ResetFrontend123!' }),
  })).status, 200);
  await env.closePage(resetPage);

  const verifyToken = crypto.randomBytes(32).toString('hex');
  const verifyHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
  env.fixtureDb.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').run(createdId);
  env.fixtureDb.prepare('INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    createdId,
    verifyHash,
    new Date(Date.now() + 60000).toISOString()
  );
  const verifyPage = await env.createTrackedPage(context);
  await verifyPage.goto(`${env.frontendBase}/verify-email.html?token=${verifyToken}`);
  await verifyPage.locator('#status').getByText(/Email verified/).waitFor();
  assert.ok(env.fixtureDb.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(createdId).email_verified_at);
  await verifyPage.goto(`${env.frontendBase}/verify-email.html`);
  await verifyPage.locator('#status').getByText(/missing a token/i).waitFor();
  await env.closePage(verifyPage);

  const forgotContext = await env.createContext();
  const forgotPage = await env.createTrackedPage(forgotContext);
  await forgotPage.goto(`${env.frontendBase}/index.html`);
  await forgotPage.getByRole('button', { name: 'Forgot password?' }).click();
  await forgotPage.locator('#forgotPasswordForm').waitFor();
  await forgotPage.locator('#forgotEmail').fill(accounts.employee.email);
  await forgotPage.locator('#forgotPhone').fill('+15555550126');
  await forgotPage.getByRole('button', { name: 'Request password reset' }).click();
  await forgotPage.locator('#loginError:not(.alert-hidden)').waitFor();
  assert.match(await forgotPage.locator('#loginError').innerText(), /If the details match an account/i);
  await env.closeContext(forgotContext);
});