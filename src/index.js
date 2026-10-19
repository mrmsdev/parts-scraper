import { ConcurrentScraper } from './scraper/concurrentScraper.js';
import { PARTZILLA_MANUFACTURERS } from './config.js';
import { logger } from './utils/logger.js';

function printHelp() {
  const mfgList = PARTZILLA_MANUFACTURERS.map((m) => m.slug).join(', ');
  console.log(`
Partzilla OEM Parts Scraper
===========================

Scrapes one manufacturer and one year per run with dedicated data and failure logs.

Usage: node src/index.js -m <manufacturer> -y <year> [options]

Required Arguments:
  -m, --manufacturer <name>   Single manufacturer: ${mfgList}
  -y, --year <year>           Single 4-digit year (e.g. 2024)

Options:
  -c, --category <name>       Single category: atv, side-by-side (default: both)
  -p, --concurrency <N>       Concurrent tabs per worker (default: 10)
  --limit-models <N>          Limit number of models processed (useful for testing)
  --limit-assemblies <N>      Limit number of assemblies processed per model (useful for testing)
  --retry-failures            Re-attempt only previously failed assemblies for this run
  --test                      Quick test run (1 model, 1 assembly for the specified manufacturer & year)
  --login                     Perform authentication login test and save session
  --headed                    Run browser in visible mode
  -h, --help                  Show this help message

Examples:
  # Scrape Yamaha 2024 (both ATV & Side-by-side)
  node src/index.js -m yamaha -y 2024

  # Scrape Honda 2023 ATV only
  node src/index.js -m honda -y 2023 -c atv

  # Retry failed assemblies for Polaris 2024
  node src/index.js -m polaris -y 2024 --retry-failures

  # Quick smoke test on Can-Am 2024 (1 model, 1 assembly)
  node src/index.js -m can-am -y 2024 --test

Output files per run:
  Data     : output/partzilla_<manufacturer>_<year>.csv & .jsonl
  Failures : output/failures_<manufacturer>_<year>.csv & .jsonl
  Progress : output/checkpoints/<manufacturer>_<year>_checkpoint.jsonl
  `);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--manufacturer' || arg === '-m') {
      const val = args[++i];
      if (val) {
        if (val.includes(',')) {
          console.error('\nError: Only one manufacturer is allowed per run.');
          console.error(`Please specify a single manufacturer (e.g. -m yamaha).`);
          process.exit(1);
        }
        options.manufacturer = val.trim().toLowerCase();
      }
    } else if (arg === '--category' || arg === '-c') {
      const val = args[++i];
      if (val && val !== 'all') {
        options.categories = [val.trim().toLowerCase()];
      }
    } else if (arg === '--year' || arg === '-y') {
      const val = args[++i];
      if (val) {
        if (val.includes(',') || val.includes('-')) {
          console.error('\nError: Only one year is allowed per run.');
          console.error(`Please specify a single 4-digit year (e.g. -y 2024).`);
          process.exit(1);
        }
        options.year = parseInt(val, 10);
      }
    } else if (arg === '--limit-models') {
      options.limitModels = parseInt(args[++i], 10);
    } else if (arg === '--limit-assemblies') {
      options.limitAssemblies = parseInt(args[++i], 10);
    } else if (arg === '--concurrency' || arg === '-p') {
      options.concurrency = parseInt(args[++i], 10);
    } else if (arg === '--test') {
      options.test = true;
      options.limitModels = 1;
      options.limitAssemblies = 1;
    } else if (arg === '--retry-failures') {
      options.retryFailures = true;
    } else if (arg === '--login') {
      options.loginOnly = true;
    } else if (arg === '--headed') {
      options.headless = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      // Positional argument support: e.g. "node src/index.js yamaha 2026"
      const lower = arg.toLowerCase().trim();
      const isMfg = PARTZILLA_MANUFACTURERS.some(
        (m) => m.slug === lower || m.name.toLowerCase() === lower
      );
      if (isMfg && !options.manufacturer) {
        options.manufacturer = lower;
      } else if (/^\d{4}$/.test(arg) && !options.year) {
        options.year = parseInt(arg, 10);
      }
    }
  }

  // Handle defaults for --test if not provided
  if (options.test) {
    if (!options.manufacturer) options.manufacturer = 'yamaha';
    if (!options.year) options.year = 2024;
  }

  return options;
}

async function main() {
  const options = parseArgs();

  if (options.loginOnly) {
    const { ensureAuthenticated } = await import('./utils/auth.js');
    const { ScraperEngine } = await import('./scraper/engine.js');
    const engine = new ScraperEngine({
      browser: { headless: options.headless !== false },
    });
    try {
      await ensureAuthenticated(engine, { force: true });
    } finally {
      await engine.close();
    }
    return;
  }

  // Validate mandatory arguments
  if (!options.manufacturer || !options.year) {
    console.error('\n[ERROR] Missing required arguments: --manufacturer (-m) and --year (-y) are required.');
    console.error('The scraper must be run for one manufacturer and one year at a time.\n');
    console.error('Examples:');
    console.error('  node src/index.js -m yamaha -y 2024');
    console.error('  node src/index.js -m honda -y 2023');
    console.error('  node src/index.js -m polaris -y 2024 --retry-failures');
    console.error('\nRun "node src/index.js --help" for all options.\n');
    process.exit(1);
  }

  let scraper;
  try {
    scraper = new ConcurrentScraper(options);
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  // Graceful shutdown on Ctrl+C (SIGINT) or termination
  let isShuttingDown = false;
  const handleShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n\n[PAUSE] ${signal} signal received. Saving state and closing browser gracefully...`);
    try {
      await scraper.engine.close();
      console.log('Progress is fully saved to checkpoints and disk files.');
      console.log(`You can run "node src/index.js -m ${options.manufacturer} -y ${options.year}" anytime to resume!\n`);
    } catch {}
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT (Ctrl+C)'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  try {
    await scraper.run();
    logger.success('Scraping run completed.');
  } catch (err) {
    if (!isShuttingDown) {
      logger.error(`Scraping process encountered an error: ${err.message}`);
      process.exit(1);
    }
  }
}

main();
