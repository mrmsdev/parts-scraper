import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Check if a valid, unexpired session state file already exists.
 * @returns {Promise<boolean>}
 */
export async function isSavedSessionValid() {
  const sessionPath = config.auth.sessionFile;
  if (!existsSync(sessionPath)) return false;

  try {
    const raw = await fs.readFile(sessionPath, 'utf-8');
    const state = JSON.parse(raw);
    if (!state.cookies || !Array.isArray(state.cookies)) return false;

    // Check if session cookie exists
    const sessionCookie = state.cookies.find(
      (c) => c.name === '__Host-session' || c.name === 'session'
    );
    if (!sessionCookie) return false;

    // Check expiration timestamp (leave a 15-minute buffer)
    const nowSec = Date.now() / 1000;
    if (sessionCookie.expires && sessionCookie.expires > 0 && sessionCookie.expires < nowSec + 900) {
      logger.warn('Saved Partzilla session cookies have expired.');
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Perform login to Partzilla and save storageState.
 * @param {import('../scraper/engine.js').ScraperEngine} engine
 * @param {object} [options]
 * @param {boolean} [options.force=false] Force login even if session file exists
 * @returns {Promise<boolean>}
 */
export async function ensureAuthenticated(engine, options = {}) {
  const sessionFile = config.auth.sessionFile;

  if (!options.force) {
    const valid = await isSavedSessionValid();
    if (valid) {
      logger.info(`Using existing authenticated session from: ${sessionFile}`);
      return true;
    }
    logger.info('No valid or unexpired session found. Performing fresh authentication...');
  }

  const { email, password } = config.auth;
  if (!email || !password || email === 'your_email@example.com') {
    logger.warn('No Partzilla credentials set in .env. Continuing in unauthenticated guest mode.');
    return false;
  }

  logger.info(`Authenticating with Partzilla as [${email}]...`);

  await engine.init();

  // Create an authentication context without resource blocking so login form works smoothly
  const authContext = await engine.createContext({
    // Do not use existing session file during fresh login
  });

  const page = await authContext.newPage();
  page.setDefaultTimeout(30000);

  try {
    const loginUrl = `${config.baseUrl}/account/login`;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    // Wait for email and password inputs
    const emailSelector = '[data-testid="loginEmailField"], input[name="email"][type="email"]';
    const passSelector = '[data-testid="loginPasswordField"], input[name="password"][type="password"]';
    const submitSelector = '[data-testid="loginSubmit"], button[type="submit"]';

    await page.waitForSelector(emailSelector, { timeout: 15000 });
    await page.fill(emailSelector, email);
    await page.fill(passSelector, password);

    // Click Sign In
    await Promise.all([
      page.click(submitSelector),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
    ]);

    // Give the page a moment to settle cookies and session tokens
    await page.waitForTimeout(2000);

    // Check if login succeeded
    const currentUrl = page.url();
    const isStillOnLogin = currentUrl.includes('/account/login');

    if (isStillOnLogin) {
      // Check for error messages
      const errorText = await page.evaluate(() => {
        const errEl = document.querySelector('[data-testid="errorMessage"], [role="alert"], .text-red-500');
        return errEl ? errEl.textContent.trim() : null;
      });

      if (errorText) {
        logger.error(`Partzilla login failed: ${errorText}`);
      } else {
        logger.warn('Partzilla login did not redirect away from login page. Captcha or 2FA may be required.');
      }
      await engine.takeScreenshot(page, 'login_failed');
      return false;
    }

    // Save session storage state
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await authContext.storageState({ path: sessionFile });

    logger.success(`Partzilla login successful! Session saved to: ${sessionFile}`);
    return true;
  } catch (err) {
    logger.error(`Error during Partzilla login: ${err.message}`);
    await engine.takeScreenshot(page, 'login_error');
    return false;
  } finally {
    await authContext.close().catch(() => {});
  }
}

// Allow running directly via `node src/utils/auth.js`
if (process.argv[1] && process.argv[1].endsWith('auth.js')) {
  import('../scraper/engine.js').then(async ({ ScraperEngine }) => {
    const isHeaded = process.argv.includes('--headed');
    const engine = new ScraperEngine({
      browser: { headless: !isHeaded },
    });
    try {
      await ensureAuthenticated(engine, { force: true });
    } finally {
      await engine.close();
    }
  });
}
