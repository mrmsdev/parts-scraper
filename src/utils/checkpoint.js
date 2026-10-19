import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { logger } from './logger.js';

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

export class CheckpointManager {
  /**
   * @param {string} mfgSlug
   * @param {string} outputDir
   */
  constructor(mfgSlug, outputDir) {
    this.mfgSlug = mfgSlug;
    this.outputDir = outputDir;
    this.checkpointDir = path.join(outputDir, 'checkpoints');
    this.checkpointPath = path.join(this.checkpointDir, `${mfgSlug}_checkpoint.jsonl`);

    this.completedAssemblyHashes = new Set();
    this.completedModelHashes = new Set();
    this.totalParts = 0;
    this.stream = null;
  }

  /**
   * Initialize and load all previously completed progress
   */
  async init() {
    fs.mkdirSync(this.checkpointDir, { recursive: true });

    // 1. Load from checkpoint file if it exists
    if (fs.existsSync(this.checkpointPath)) {
      await this.loadFile(this.checkpointPath);
    }

    // 2. Only if checkpoint is missing or empty, sync from existing parts jsonl as fallback
    if (this.completedAssemblyHashes.size === 0) {
      const dataJsonl = path.join(this.outputDir, `partzilla_${this.mfgSlug}.jsonl`);
      if (fs.existsSync(dataJsonl)) {
        await this.loadDataJsonl(dataJsonl);
      }
    }

    // Open append stream for live checkpoint updates
    this.stream = fs.createWriteStream(this.checkpointPath, { flags: 'a', encoding: 'utf-8' });

    return {
      completedAssemblies: this.completedAssemblyHashes.size,
      totalParts: this.totalParts,
    };
  }

  async loadFile(filepath) {
    try {
      const fileStream = fs.createReadStream(filepath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.assemblyUrl) {
            this.completedAssemblyHashes.add(hashString(entry.assemblyUrl));
          }
          if (typeof entry.partCount === 'number') {
            this.totalParts += entry.partCount;
          }
          if (entry.modelCompleted) {
            this.completedModelHashes.add(hashString(entry.modelUrl));
          }
        } catch {}
      }
    } catch (err) {
      logger.warn(`Could not load checkpoint file ${filepath}: ${err.message}`);
    }
  }

  async loadDataJsonl(filepath) {
    try {
      const fileStream = fs.createReadStream(filepath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        const match = line.match(/"assemblyUrl"\s*:\s*"([^"]+)"/);
        if (match) {
          this.completedAssemblyHashes.add(hashString(match[1]));
          this.totalParts++;
        }
      }
    } catch (err) {
      logger.warn(`Could not sync from data jsonl ${filepath}: ${err.message}`);
    }
  }

  /**
   * Check if an assembly has already been scraped
   * @param {string} assemblyUrl
   * @returns {boolean}
   */
  isAssemblyCompleted(assemblyUrl) {
    return this.completedAssemblyHashes.has(hashString(assemblyUrl));
  }

  /**
   * Check if an entire model has already been completely finished
   * @param {string} modelUrl
   * @returns {boolean}
   */
  isModelCompleted(modelUrl) {
    return this.completedModelHashes.has(hashString(modelUrl));
  }

  /**
   * Mark an assembly as completed (persists instantly to disk)
   * @param {string} assemblyUrl
   * @param {number} partCount
   */
  markAssemblyCompleted(assemblyUrl, partCount = 0) {
    this.completedAssemblyHashes.add(hashString(assemblyUrl));
    this.totalParts += partCount;

    if (this.stream) {
      this.stream.write(
        JSON.stringify({
          assemblyUrl,
          partCount,
          timestamp: new Date().toISOString(),
        }) + '\n'
      );
    }
  }

  /**
   * Mark an entire model as completed
   * @param {string} modelUrl
   */
  markModelCompleted(modelUrl) {
    this.completedModelHashes.add(hashString(modelUrl));

    if (this.stream) {
      this.stream.write(
        JSON.stringify({
          modelUrl,
          modelCompleted: true,
          timestamp: new Date().toISOString(),
        }) + '\n'
      );
    }
  }

  /**
   * Close stream safely
   */
  async close() {
    if (this.stream) {
      await new Promise((resolve) => this.stream.end(resolve));
      this.stream = null;
    }
  }
}
