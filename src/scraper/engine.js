import { chromium } from 'playwright';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export class ScraperEngine {
  constructor(customConfig = {}) {
    this.config = { ...config, ...customConfig };
    this.browser = null;
    this.contexts = [];
  }

  /**
   * Launch shared browser instance
   */
  async init() {
    if (this.browser) return;

    logger.info(
      `Launching Chromium engine (headless: ${this.config.browser.headless})...`
    );

    this.browser = await chromium.launch({
      headless: this.config.browser.headless,
      slowMo: this.config.browser.slowMo,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    logger.success('Shared browser engine initialized.');
  }

  /**
   * Create an isolated browser context for a specific worker
   * @param {object} [customOptions]
   * @returns {Promise<import('playwright').BrowserContext>}
   */
  async createContext(customOptions = {}) {
    if (!this.browser) {
      await this.init();
    }

    let storageState = customOptions.storageState;
    if (!storageState && this.config.auth?.sessionFile && existsSync(this.config.auth.sessionFile)) {
      storageState = this.config.auth.sessionFile;
    }

    const context = await this.browser.newContext({
      viewport: this.config.context.viewport,
      userAgent: this.config.context.userAgent,
      locale: this.config.context.locale,
      timezoneId: this.config.context.timezoneId,
      ...(storageState ? { storageState } : {}),
      ...customOptions,
    });

    // Mask automation detection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    context.on('close', () => {
      this.contexts = this.contexts.filter((c) => c !== context);
    });

    this.contexts.push(context);
    return context;
  }

  /**
   * Create a new page inside a specific context with resource routing
   * @param {import('playwright').BrowserContext} context
   * @param {object} [options]
   * @returns {Promise<import('playwright').Page>}
   */
  async createPage(context, options = {}) {
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.browser.timeout);

    const blockResourceTypes =
      options.blockResourceTypes ?? this.config.scraping.blockResourceTypes ?? ['media', 'font'];
    const blockedDomains =
      options.blockedDomains ?? this.config.scraping.blockedDomains ?? [];

    await page.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      const url = req.url().toLowerCase();

      if (blockResourceTypes.includes(type)) {
        return route.abort();
      }

      for (const domain of blockedDomains) {
        if (url.includes(domain)) {
          return route.abort();
        }
      }

      return route.continue();
    });

    return page;
  }

  /**
   * Safe navigation with retry logic and backoff
   * @param {import('playwright').Page} page
   * @param {string} url
   * @param {object} [options]
   * @param {string} [prefix]
   */
  async safeGoto(page, url, options = {}, prefix = '') {
    const maxRetries = options.maxRetries ?? this.config.scraping.maxRetries;
    const waitUntil = options.waitUntil || 'domcontentloaded';
    const tag = prefix ? `${prefix} ` : '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await page.goto(url, {
          waitUntil,
          timeout: this.config.browser.timeout,
          ...options,
        });

        if (response) {
          const status = response.status();
          if (status === 429 || status === 503) {
            const backoff = 2500 * Math.pow(2, attempt);
            logger.warn(
              `${tag}Rate limit / server busy (HTTP ${status}) on ${url}. Backing off for ${backoff}ms (attempt ${attempt}/${maxRetries})...`
            );
            await this.delay(backoff);
            continue;
          }
        }

        if (this.config.scraping.requestDelayMs > 0) {
          await this.delay(this.config.scraping.requestDelayMs);
        }

        return response;
      } catch (err) {
        logger.warn(`${tag}Navigation attempt ${attempt}/${maxRetries} failed on ${url}: ${err.message}`);
        if (attempt === maxRetries) {
          await this.takeScreenshot(page, `error_${Date.now()}`);
          throw err;
        }
        await this.delay(1000 * Math.pow(2, attempt - 1));
      }
    }
  }

  /**
   * Capture full-page screenshot
   * @param {import('playwright').Page} page
   * @param {string} name
   */
  async takeScreenshot(page, name) {
    try {
      await fs.mkdir(this.config.paths.screenshotsDir, { recursive: true });
      const filepath = path.join(
        this.config.paths.screenshotsDir,
        `${name}.png`
      );
      await page.screenshot({ path: filepath, fullPage: true });
      return filepath;
    } catch {
      return null;
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Close all contexts and browser
   */
  async close() {
    for (const ctx of this.contexts) {
      await ctx.close().catch(() => {});
    }
    this.contexts = [];

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    logger.info('All browser worker contexts and browser closed.');
  }
}
