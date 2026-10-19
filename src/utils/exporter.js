import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const CSV_COLUMNS = [
  'manufacturer',
  'category',
  'year',
  'modelName',
  'modelUrl',
  'assemblyName',
  'assemblyUrl',
  'diagramImageUrl',
  'refNumber',
  'partName',
  'sku',
  'priceRaw',
  'price',
  'msrp',
  'availability',
  'productUrl',
  'scrapedAt',
];

export function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function recordToCsvRow(record) {
  return CSV_COLUMNS.map((col) => escapeCsvField(record[col])).join(',');
}

/**
 * Dedicated disk stream writer for a manufacturer or dataset
 * Keeps RAM usage at 0 by directly piping to disk
 */
export class StreamExporter {
  constructor(baseFilename, outputDir) {
    this.outputDir = outputDir;
    this.baseFilename = baseFilename;
    this.csvPath = path.join(outputDir, `${baseFilename}.csv`);
    this.jsonlPath = path.join(outputDir, `${baseFilename}.jsonl`);

    fs.mkdirSync(outputDir, { recursive: true });

    // Initialize CSV with header if not existing or empty
    const csvExists = fs.existsSync(this.csvPath) && fs.statSync(this.csvPath).size > 0;
    this.csvStream = fs.createWriteStream(this.csvPath, { flags: 'a', encoding: 'utf-8' });
    if (!csvExists) {
      this.csvStream.write(CSV_COLUMNS.join(',') + '\n');
    }

    this.jsonlStream = fs.createWriteStream(this.jsonlPath, { flags: 'a', encoding: 'utf-8' });
  }

  /**
   * Immediately write records to CSV and JSONL on disk
   * @param {Array<object>} records
   */
  write(records) {
    if (!records || records.length === 0) return;

    let csvChunk = '';
    let jsonlChunk = '';

    for (const record of records) {
      csvChunk += recordToCsvRow(record) + '\n';
      jsonlChunk += JSON.stringify(record) + '\n';
    }

    this.csvStream.write(csvChunk);
    this.jsonlStream.write(jsonlChunk);
  }

  /**
   * Close file streams
   */
  async close() {
    await new Promise((resolve) => this.csvStream.end(resolve));
    await new Promise((resolve) => this.jsonlStream.end(resolve));
  }
}

/**
 * Stream-convert JSONL file to formatted JSON array without holding all objects in RAM
 * @param {string} jsonlPath
 * @param {string} jsonPath
 */
export async function streamConvertJsonlToJson(jsonlPath, jsonPath) {
  if (!fs.existsSync(jsonlPath)) return;

  const inStream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const outStream = fs.createWriteStream(jsonPath, { encoding: 'utf-8' });

  outStream.write('[\n');
  let first = true;

  const rl = (await import('readline')).createInterface({
    input: inStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!first) {
      outStream.write(',\n');
    }
    outStream.write('  ' + line.trim());
    first = false;
  }

  outStream.write('\n]\n');
  await new Promise((resolve) => outStream.end(resolve));
}
