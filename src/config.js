import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

try {
  process.loadEnvFile();
} catch {
  // .env file is optional
}

export const PARTZILLA_MANUFACTURERS = [
  { name: 'Honda', slug: 'honda' },
  { name: 'Polaris', slug: 'polaris' },
  { name: 'Yamaha', slug: 'yamaha' },
  { name: 'Can-Am', slug: 'can-am' },
  { name: 'Kawasaki', slug: 'kawasaki' },
];

export const PARTZILLA_CATEGORIES = ['atv', 'side-by-side'];

export const TARGET_YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

export const config = {
  baseUrl: 'https://www.partzilla.com',

  // Authentication & session settings
  auth: {
    email: process.env.PARTZILLA_EMAIL || '',
    password: process.env.PARTZILLA_PASSWORD || '',
    sessionFile: path.join(rootDir, 'output', 'session_state.json'),
  },

  // Browser settings
  browser: {
    headless: !process.argv.includes('--headed'),
    slowMo: 0,
    timeout: 30000,
  },

  // Context & Anti-bot settings
  context: {
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },

  // Scraping behavior & performance tuning
  scraping: {
    concurrency: 10,
    requestDelayMs: 0,
    maxRetries: 3,
    recyclePageAfter: 30, // Recycles individual browser page tab every 30 assemblies
    recycleContextAfter: 200, // Completely recycles browser context every 200 assemblies to flush Chromium memory
    blockResourceTypes: ['image', 'stylesheet', 'media', 'font'],
    blockedDomains: [
      'google',
      'bing',
      'sentry',
      'bazaarvoice',
      'doubleclick',
      'ahrefs',
      'mypurecloud',
      'termly',
      'facebook',
      'criteo',
      'klaviyo',
      'avmws',
      'datadog',
      'hotjar',
      'segment',
      'clarity.ms',
      'fullstory',
      'google-analytics',
      'googletagmanager',
    ],
  },

  // Storage paths
  paths: {
    root: rootDir,
    outputDir: path.join(rootDir, 'output'),
    screenshotsDir: path.join(rootDir, 'screenshots'),
  },
};
