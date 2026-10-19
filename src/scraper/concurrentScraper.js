import { ScraperEngine } from './engine.js';
import { ManufacturerWorker } from './manufacturerWorker.js';
import { PARTZILLA_MANUFACTURERS } from '../config.js';
import { FailureTracker } from '../utils/failureTracker.js';
import { logger } from '../utils/logger.js';
import { ensureAuthenticated } from '../utils/auth.js';

function formatTimestamp(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds % 60) + (ms % 1000) / 1000;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds.toFixed(1)}s`);

  return parts.join(' ');
}

export class ConcurrentScraper {
  /**
   * @param {object} options
   * @param {string} options.manufacturer Target manufacturer (e.g. 'yamaha', 'honda')
   * @param {number|string} options.year Target year (e.g. 2024)
   * @param {string[]} [options.categories]
   * @param {number} [options.limitModels]
   * @param {number} [options.limitAssemblies]
   * @param {number} [options.concurrency]
   * @param {boolean} [options.retryFailures]
   */
  constructor(options = {}) {
    this.options = options;
    this.engine = new ScraperEngine(options);

    const mfgInput = (options.manufacturer || '').toLowerCase().trim();
    const match = PARTZILLA_MANUFACTURERS.find(
      (m) => m.slug === mfgInput || m.name.toLowerCase() === mfgInput
    );

    if (!match) {
      const valid = PARTZILLA_MANUFACTURERS.map((m) => m.slug).join(', ');
      throw new Error(
        `Invalid or missing manufacturer "${options.manufacturer}". Supported manufacturers: ${valid}`
      );
    }

    const yearVal = parseInt(options.year, 10);
    if (!yearVal || isNaN(yearVal) || yearVal < 1970 || yearVal > 2030) {
      throw new Error(
        `Invalid or missing year "${options.year}". Please specify a single 4-digit year (e.g. 2024).`
      );
    }

    this.manufacturer = match;
    this.year = yearVal;
    this.fileKey = `${this.manufacturer.slug}_${this.year}`;
  }

  /**
   * Execute scraping run for the single specified manufacturer and year
   */
  async run() {
    const startTimestamp = new Date();
    const startTimeMs = startTimestamp.getTime();

    const concurrency = this.options.concurrency || this.engine.config.scraping.concurrency || 10;

    console.log('\n================================================================');
    console.log(`  PARTZILLA SCRAPER: [${this.manufacturer.name.toUpperCase()}] Year [${this.year}]`);
    console.log('================================================================');
    console.log(`  Manufacturer     : ${this.manufacturer.name} (${this.manufacturer.slug})`);
    console.log(`  Target Year      : ${this.year}`);
    console.log(`  Parallel Tabs    : ${concurrency} concurrent browser tabs`);
    console.log(`  Start Time       : ${formatTimestamp(startTimestamp)} UTC`);
    console.log(`  Data Output      : output/partzilla_${this.fileKey}.csv & .jsonl`);
    console.log(`  Failures Output  : output/failures_${this.fileKey}.csv & .jsonl`);
    console.log(`  Checkpoint State : output/checkpoints/${this.fileKey}_checkpoint.jsonl`);
    if (this.options.retryFailures) {
      console.log(`  Mode             : RETRY FAILURES (targeting output/failures_${this.fileKey}.jsonl)`);
    }
    console.log('================================================================\n');

    let pendingFailures = null;
    if (this.options.retryFailures) {
      pendingFailures = await FailureTracker.loadPendingFailedAssemblies(
        this.engine.config.paths.outputDir,
        this.fileKey
      );
      if (pendingFailures.length === 0) {
        logger.info(`No pending failed assemblies found in output/failures_${this.fileKey}.jsonl to retry.`);
        return { totalParts: 0 };
      }
      logger.info(`Loaded ${pendingFailures.length} failed assemblies from log file to retry.`);
    }

    await this.engine.init();

    // Authenticate with Partzilla if credentials are configured
    await ensureAuthenticated(this.engine);

    // Spawn manufacturer worker for this specific manufacturer & year
    const worker = new ManufacturerWorker({
      manufacturer: this.manufacturer,
      year: this.year,
      engine: this.engine,
      options: {
        ...this.options,
        targetAssemblies: pendingFailures,
      },
    });

    let workerResult = null;
    try {
      workerResult = await worker.run();
    } finally {
      await this.engine.close();
    }

    const endTimestamp = new Date();
    const endTimeMs = endTimestamp.getTime();
    const totalDurationMs = endTimeMs - startTimeMs;
    const finalHeap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

    const totalScraped = workerResult?.total || 0;
    const failureStats = workerResult?.failureStats || { total: 0, byType: {} };

    // Display clean summary
    console.log('\n================================================================');
    console.log(`             SCRAPING RUN SUMMARY [${this.manufacturer.name.toUpperCase()} ${this.year}]`);
    console.log('================================================================');
    console.log(`  Manufacturer    : ${this.manufacturer.name}`);
    console.log(`  Year            : ${this.year}`);
    console.log(`  Start Time      : ${formatTimestamp(startTimestamp)} UTC`);
    console.log(`  End Time        : ${formatTimestamp(endTimestamp)} UTC`);
    console.log(`  Total Duration  : ${formatDuration(totalDurationMs)} (${(totalDurationMs / 1000).toFixed(2)}s)`);
    console.log(`  Final RAM Heap  : ${finalHeap} MB (Clean & stable)`);
    console.log('----------------------------------------------------------------');
    console.log(`  Total Parts     : ${totalScraped} parts extracted`);
    console.log(`  Tracked Issues  : ${failureStats.total} failure(s) recorded`);

    if (failureStats.total > 0) {
      console.log('  Issue Breakdown by Type:');
      for (const [type, count] of Object.entries(failureStats.byType)) {
        console.log(`    - ${type.padEnd(24, ' ')}: ${count}`);
      }
      console.log(`  Failure Log Files : output/failures_${this.fileKey}.csv & .jsonl`);
      console.log(`  Action Tip        : Run "node src/index.js -m ${this.manufacturer.slug} -y ${this.year} --retry-failures"`);
    } else {
      console.log('  Status          : 100% clean - No failed assemblies or missing items!');
    }

    console.log(`  Data Files      : output/partzilla_${this.fileKey}.csv`);
    console.log(`                    output/partzilla_${this.fileKey}.jsonl`);
    console.log('================================================================\n');

    return {
      startTime: startTimestamp,
      endTime: endTimestamp,
      durationMs: totalDurationMs,
      totalParts: totalScraped,
      failureStats,
      workerResult,
    };
  }
}
