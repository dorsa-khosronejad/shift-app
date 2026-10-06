const env = require('../support/environment');

async function signIn(page, role, override = null) {
  const account = override || env.accounts[role];
  await page.goto(env.frontendBase + '/index.html');
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/' + account.home);
  const badge = role === 'employee' ? 'Employee' : role === 'manager' ? 'Manager' : 'Admin';
  await page.getByText(badge, { exact: true }).first().waitFor();
}

module.exports = { signIn };
