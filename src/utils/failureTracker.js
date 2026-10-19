import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { escapeCsvField, streamConvertJsonlToJson } from './exporter.js';
import { logger } from './logger.js';

export const FAILURE_CSV_COLUMNS = [
  'timestamp',
  'manufacturer',
  'category',
  'year',
  'modelName',
  'modelUrl',
  'assemblyName',
  'assemblyUrl',
  'sku',
  'failedStage',
  'failureType',
  'errorMessage',
  'url',
];

export class FailureTracker {
  /**
   * @param {string} mfgSlug Manufacturer slug or 'all'
   * @param {string} outputDir Output directory path
   */
  constructor(mfgSlug = 'all', outputDir) {
    this.mfgSlug = mfgSlug;
    this.outputDir = outputDir;
    this.baseFilename = `failures_${mfgSlug}`;
    this.csvPath = path.join(outputDir, `${this.baseFilename}.csv`);
    this.jsonlPath = path.join(outputDir, `${this.baseFilename}.jsonl`);

    fs.mkdirSync(outputDir, { recursive: true });

    const csvExists = fs.existsSync(this.csvPath) && fs.statSync(this.csvPath).size > 0;
    this.csvStream = fs.createWriteStream(this.csvPath, { flags: 'a', encoding: 'utf-8' });
    if (!csvExists) {
      this.csvStream.write(FAILURE_CSV_COLUMNS.join(',') + '\n');
    }

    this.jsonlStream = fs.createWriteStream(this.jsonlPath, { flags: 'a', encoding: 'utf-8' });

    this.total = 0;
    this.byType = {};
    this.byStage = {};
    this.recordedUrls = new Set();
  }

  /**
   * Record a failure event to disk streams
   * @param {object} item
   */
  record(item) {
    const record = {
      timestamp: item.timestamp || new Date().toISOString(),
      manufacturer: item.manufacturer || '',
      category: item.category || '',
      year: item.year !== undefined && item.year !== null ? String(item.year) : '',
      modelName: item.modelName || '',
      modelUrl: item.modelUrl || '',
      assemblyName: item.assemblyName || '',
      assemblyUrl: item.assemblyUrl || '',
      sku: item.sku || '',
      failedStage: item.failedStage || 'unknown',
      failureType: item.failureType || 'UNKNOWN_ERROR',
      errorMessage: (item.errorMessage || '').replace(/[\r\n]+/g, ' ').trim(),
      url: item.url || item.assemblyUrl || item.modelUrl || '',
    };

    const csvRow = FAILURE_CSV_COLUMNS.map((col) => escapeCsvField(record[col])).join(',') + '\n';
    const jsonlRow = JSON.stringify(record) + '\n';

    this.csvStream.write(csvRow);
    this.jsonlStream.write(jsonlRow);

    this.total++;
    this.byType[record.failureType] = (this.byType[record.failureType] || 0) + 1;
    this.byStage[record.failedStage] = (this.byStage[record.failedStage] || 0) + 1;
    if (record.url) {
      this.recordedUrls.add(record.url);
    }
  }

  /**
   * Get failure statistics
   */
  getStats() {
    return {
      total: this.total,
      byType: { ...this.byType },
      byStage: { ...this.byStage },
    };
  }

  /**
   * Safely close file streams
   */
  async close() {
    await Promise.all([
      new Promise((resolve) => this.csvStream.end(resolve)),
      new Promise((resolve) => this.jsonlStream.end(resolve)),
    ]);
  }

  /**
   * Load all unique failed assemblies from failure files
   * @param {string} outputDir
   * @param {string|Array<{slug: string}>} [target] fileKey string or array of manufacturers
   * @returns {Promise<Array<object>>}
   */
  static async loadPendingFailedAssemblies(outputDir, target) {
    const pendingList = [];
    const seenUrls = new Set();

    let candidateFiles = [];
    if (typeof target === 'string') {
      candidateFiles = [path.join(outputDir, `failures_${target}.jsonl`)];
    } else if (Array.isArray(target) && target.length > 0) {
      candidateFiles = target.map((m) =>
        path.join(outputDir, `failures_${typeof m === 'string' ? m : m.slug}.jsonl`)
      );
    } else {
      candidateFiles = [path.join(outputDir, 'partzilla_failures.jsonl')];
    }

    for (const filePath of candidateFiles) {
      if (!fs.existsSync(filePath)) continue;
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          const targetUrl = item.assemblyUrl || item.url;
          if (targetUrl && item.failedStage === 'assembly_extraction' && !seenUrls.has(targetUrl)) {
            seenUrls.add(targetUrl);
            pendingList.push(item);
          }
        } catch {}
      }
    }

    return pendingList;
  }
}
