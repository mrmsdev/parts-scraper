import { StreamExporter } from '../utils/exporter.js';
import { CheckpointManager } from '../utils/checkpoint.js';
import { FailureTracker } from '../utils/failureTracker.js';
import { logger } from '../utils/logger.js';
import { extractAssemblyData } from '../utils/domExtractors.js';

/**
 * Manages an isolated page tab with periodic recycling for Chromium memory stability
 */
class PageSlot {
  constructor(engine, context, tag, recycleInterval) {
    this.engine = engine;
    this.context = context;
    this.tag = tag;
    this.recycleInterval = recycleInterval;
    this.page = null;
    this.navCount = 0;
  }

  async getPage() {
    if (!this.page || this.page.isClosed()) {
      this.page = await this.engine.createPage(this.context);
      this.navCount = 0;
    }
    this.navCount++;
    if (this.navCount >= this.recycleInterval) {
      try {
        await this.page.close();
      } catch {}
      this.page = await this.engine.createPage(this.context);
      this.navCount = 0;
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
      logger.info(`${this.tag} Recycled page tab for memory maintenance (Node heap: ${mem} MB)`);
    }
    return this.page;
  }

  async reset() {
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close();
      } catch {}
    }
    this.page = null;
    this.navCount = 0;
  }

  async close() {
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close();
      } catch {}
      this.page = null;
    }
  }
}

export class ManufacturerWorker {
  /**
   * @param {object} params
   * @param {{ name: string, slug: string }} params.manufacturer
   * @param {number|string} params.year
   * @param {import('./engine.js').ScraperEngine} params.engine
   * @param {object} [params.options]
   */
  constructor({ manufacturer, year, engine, options = {} }) {
    this.mfg = manufacturer;
    this.year = parseInt(year, 10);
    this.engine = engine;
    this.options = options;
    this.categories = options.categories || ['atv', 'side-by-side'];
    this.limitModels = options.limitModels || null;
    this.limitAssemblies = options.limitAssemblies || null;
    this.concurrency = options.concurrency || engine.config.scraping.concurrency || 10;
    this.baseUrl = engine.config.baseUrl || 'https://www.partzilla.com';
    this.fileKey = `${this.mfg.slug}_${this.year}`;
    this.tag = `[${this.mfg.name.toUpperCase()} ${this.year}]`;

    this.filename = `partzilla_${this.fileKey}`;
    this.recycleInterval = engine.config.scraping.recyclePageAfter || 30;
    this.recycleContextAfter = engine.config.scraping.recycleContextAfter || 200;
    this.batchCount = 0;

    // Checkpoint manager for this specific manufacturer & year
    this.checkpoint = new CheckpointManager(
      this.fileKey,
      this.engine.config.paths.outputDir
    );

    // Dedicated failure tracker for this specific manufacturer & year
    this.failureTracker = new FailureTracker(
      this.fileKey,
      this.engine.config.paths.outputDir
    );

    // Direct streaming exporter for this specific manufacturer & year
    this.exporter = new StreamExporter(
      this.filename,
      this.engine.config.paths.outputDir
    );

    this.totalPartsScraped = 0;
    this.context = null;
    this.navPage = null;
    this.pool = [];
  }

  /**
   * Periodically recycle browser context to completely purge Chromium memory and CDP buffers
   */
  async recycleContextIfNeeded() {
    this.batchCount++;
    if (this.batchCount < this.recycleContextAfter) return;
    this.batchCount = 0;

    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
    logger.info(`${this.tag} Periodic browser context recycling to purge Chromium RAM (Node heap: ${mem} MB)...`);

    if (this.pool && this.pool.length > 0) {
      await Promise.all(this.pool.map((s) => s.close())).catch(() => {});
    }
    if (this.navPage && !this.navPage.isClosed()) {
      await this.navPage.close().catch(() => {});
    }
    if (this.context) {
      await this.context.close().catch(() => {});
    }

    this.context = await this.engine.createContext();
    this.navPage = await this.engine.createPage(this.context);
    this.pool = Array.from(
      { length: this.concurrency },
      () => new PageSlot(this.engine, this.context, this.tag, this.recycleInterval)
    );
  }

  /**
   * Run the scraping task for this manufacturer & year with parallel tab pool
   */
  async run() {
    // 1. Initialize checkpoint to load existing progress
    const { completedAssemblies, totalParts } = await this.checkpoint.init();
    this.totalPartsScraped = totalParts;

    if (completedAssemblies > 0) {
      logger.info(
        `${this.tag} RESUME ACTIVE: ${completedAssemblies} assemblies already completed (${totalParts} parts on disk). Skipping completed work...`
      );
    }

    // 2. Create isolated browser context for this worker
    this.context = await this.engine.createContext();
    this.navPage = await this.engine.createPage(this.context);

    // Initialize parallel page slots pool
    this.pool = Array.from(
      { length: this.concurrency },
      () => new PageSlot(this.engine, this.context, this.tag, this.recycleInterval)
    );

    const workerStartTime = Date.now();
    logger.info(
      `${this.tag} Worker started at ${new Date(workerStartTime)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19)} with ${this.concurrency} concurrent tabs.`
    );
    logger.info(`${this.tag} Target: [${this.mfg.name}] Year [${this.year}] | Output: output/${this.filename}.csv & .jsonl`);

    try {
      // Prime Cloudflare session
      await this.engine.safeGoto(this.navPage, this.baseUrl, {}, this.tag);
      await this.navPage.waitForTimeout(500);

      // Check if running in targeted retry mode for previously failed assemblies
      if (this.options.targetAssemblies && this.options.targetAssemblies.length > 0) {
        logger.info(
          `${this.tag} RETRY MODE: Targeting ${this.options.targetAssemblies.length} previously failed assemblies...`
        );
        const pendingAssemblies = this.options.targetAssemblies.filter(
          (a) => !this.checkpoint.isAssemblyCompleted(a.assemblyUrl || a.url)
        );

        if (pendingAssemblies.length > 0) {
          await this.processAssemblyBatch(pendingAssemblies);
        } else {
          logger.info(`${this.tag} All target retry assemblies were already marked completed.`);
        }
      } else {
        // Direct category traversal for this specific year
        for (const cat of this.categories) {
          const yearUrl = `${this.baseUrl}/catalog/${this.mfg.slug}/${cat}/${this.year}`;
          logger.info(`${this.tag} Traversing Category: ${cat.toUpperCase()} (${yearUrl})`);

          const models = await this.getModelsForYear(this.navPage, yearUrl);
          if (!models || models.length === 0) {
            logger.info(`${this.tag} No models found for Category [${cat.toUpperCase()}] Year [${this.year}].`);
            continue;
          }

          // Fast skip if all models in this category & year are already completed
          const allModelsDone = models.every((m) => this.checkpoint.isModelCompleted(m.url));
          if (allModelsDone) {
            logger.info(`${this.tag}   [SKIP CATEGORY] All ${models.length} models already completed for ${cat.toUpperCase()} ${this.year}`);
            continue;
          }

          for (const model of models) {
            // Check if model was already 100% completed
            if (this.checkpoint.isModelCompleted(model.url)) {
              logger.info(`${this.tag}   [SKIP MODEL] All assemblies already completed for: ${model.name}`);
              continue;
            }

            logger.info(`${this.tag}   -> Model: [${model.name}]`);
            const assemblies = await this.getAssembliesForModel(this.navPage, model.url);

            const pendingAssemblies = assemblies.filter(
              (a) => !this.checkpoint.isAssemblyCompleted(a.url)
            );

            if (pendingAssemblies.length === 0) {
              if (assemblies.length > 0) {
                this.checkpoint.markModelCompleted(model.url);
              }
              continue;
            }

            // Process pending assemblies concurrently using the page pool
            await this.processAssemblyBatch(pendingAssemblies, {
              category: cat,
              year: this.year,
              modelName: model.name,
              modelUrl: model.url,
            });

            // Mark model completed
            this.checkpoint.markModelCompleted(model.url);
          }
        }
      }

      const workerDurationMs = Date.now() - workerStartTime;
      const workerElapsed = (workerDurationMs / 1000).toFixed(1);
      const failureStats = this.failureTracker.getStats();

      logger.success(
        `${this.tag} COMPLETED in ${workerElapsed}s! Total parts scraped: ${this.totalPartsScraped} (Failures/issues: ${failureStats.total})`
      );

      return {
        manufacturer: this.mfg.name,
        year: this.year,
        total: this.totalPartsScraped,
        durationMs: workerDurationMs,
        failureStats,
        csvPath: this.exporter.csvPath,
        jsonlPath: this.exporter.jsonlPath,
        failureCsvPath: this.failureTracker.csvPath,
        failureJsonlPath: this.failureTracker.jsonlPath,
      };
    } catch (err) {
      logger.error(`${this.tag} Worker failed: ${err.message}`);
      if (this.navPage && !this.navPage.isClosed()) {
        await this.engine.takeScreenshot(this.navPage, `crash_${this.fileKey}_${Date.now()}`);
      }
      throw err;
    } finally {
      if (this.pool && this.pool.length > 0) {
        await Promise.all(this.pool.map((slot) => slot.close())).catch(() => {});
      }
      if (this.navPage && !this.navPage.isClosed()) {
        await this.navPage.close().catch(() => {});
      }
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      await this.exporter.close();
      await this.failureTracker.close();
      await this.checkpoint.close();
    }
  }

  /**
   * Process a list of assemblies across worker tab pool
   * @param {Array<object>} items
   * @param {object} [defaultMeta]
   */
  async processAssemblyBatch(items, defaultMeta = {}) {
    let nextIndex = 0;
    const activeWorkers = Math.min(this.concurrency, items.length);

    const workerTask = async (slot) => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        if (!item) break;
        await this.processAssemblyItem(slot, item, defaultMeta);
      }
    };

    await Promise.all(this.pool.slice(0, activeWorkers).map((slot) => workerTask(slot)));
    await this.recycleContextIfNeeded();
  }

  /**
   * Process a single assembly item with failure tracking and memory recovery
   * @param {PageSlot} slot
   * @param {object} assembly
   * @param {object} [defaultMeta]
   */
  async processAssemblyItem(slot, assembly, defaultMeta = {}) {
    const targetUrl = assembly.assemblyUrl || assembly.url;
    const meta = {
      manufacturer: this.mfg.name,
      category: assembly.category || defaultMeta.category || 'unknown',
      year: assembly.year || defaultMeta.year || 'unknown',
      modelName: assembly.name && !assembly.assemblyName ? defaultMeta.modelName : assembly.modelName || defaultMeta.modelName || 'unknown',
      modelUrl: assembly.modelUrl || defaultMeta.modelUrl || '',
      assemblyName: assembly.assemblyName || assembly.name || 'unknown',
      assemblyUrl: targetUrl,
    };

    try {
      const page = await slot.getPage();

      const extractionResult = await this.extractAssemblyDetails(page, targetUrl, meta);
      const parts = extractionResult.parts || [];
      const diagramUrl = extractionResult.diagramImageUrl || '';

      if (parts.length > 0) {
        this.exporter.write(parts);
        this.totalPartsScraped += parts.length;
        this.checkpoint.markAssemblyCompleted(targetUrl, parts.length);
        logger.success(
          `${this.tag}      [PARALLEL] Extracted ${parts.length} parts from [${meta.assemblyName}] (Total: ${this.totalPartsScraped})`
        );

        // Track warning if diagram image is missing
        if (!diagramUrl) {
          this.failureTracker.record({
            ...meta,
            failedStage: 'assembly_extraction',
            failureType: 'MISSING_DIAGRAM',
            errorMessage: 'Parts were extracted, but diagram image URL was missing',
            url: targetUrl,
          });
        }
      } else {
        // Page loaded, but 0 parts were extracted
        let failureType = 'EMPTY_EXTRACTION';
        let reason = 'No parts extracted (table not found or empty)';

        if (extractionResult.pageTitle && extractionResult.pageTitle.includes('Just a moment')) {
          failureType = 'CLOUDFLARE_BLOCKED';
          reason = 'Cloudflare verification challenge encountered';
        } else if (extractionResult.hasTable && extractionResult.rawRowCount > 0) {
          failureType = 'DOM_PARSE_MISMATCH';
          reason = `Table found with ${extractionResult.rawRowCount} rows, but neither SKU nor partName matched`;
        }

        logger.warn(`${this.tag}      ${reason} in [${meta.assemblyName}]`);
        this.failureTracker.record({
          ...meta,
          failedStage: 'assembly_extraction',
          failureType,
          errorMessage: reason,
          url: targetUrl,
        });
        // Do not mark completed in checkpoint so it remains eligible for retry
      }
    } catch (err) {
      logger.error(`${this.tag}      Failed assembly [${meta.assemblyName}]: ${err.message}`);
      this.failureTracker.record({
        ...meta,
        failedStage: 'assembly_extraction',
        failureType: 'EXTRACTION_ERROR',
        errorMessage: err.message,
        url: targetUrl,
      });
      // Reset page slot to recover from any navigation or memory freeze
      await slot.reset();
    }
  }

  /**
   * Extract models for year
   */
  async getModelsForYear(page, yearUrl) {
    try {
      await this.engine.safeGoto(page, yearUrl, {}, this.tag);
    } catch (err) {
      logger.error(`${this.tag} Failed to load year page [${yearUrl}]: ${err.message}`);
      this.failureTracker.record({
        manufacturer: this.mfg.name,
        failedStage: 'model_discovery',
        failureType: 'NAVIGATION_ERROR',
        errorMessage: err.message,
        url: yearUrl,
      });
      return [];
    }

    const models = await page.evaluate((currentUrl) => {
      const links = Array.from(document.querySelectorAll('a'));
      const results = [];
      const seen = new Set();

      for (const a of links) {
        if (a.href.startsWith(currentUrl) && a.href !== currentUrl && !a.href.includes('#')) {
          const name = a.textContent.trim();
          if (name && !seen.has(a.href)) {
            seen.add(a.href);
            results.push({ name, url: a.href });
          }
        }
      }
      return results;
    }, yearUrl);

    return this.limitModels ? models.slice(0, this.limitModels) : models;
  }

  /**
   * Extract assemblies for model
   */
  async getAssembliesForModel(page, modelUrl) {
    try {
      await this.engine.safeGoto(page, modelUrl, {}, this.tag);
    } catch (err) {
      logger.error(`${this.tag} Failed to load model page [${modelUrl}]: ${err.message}`);
      this.failureTracker.record({
        manufacturer: this.mfg.name,
        failedStage: 'assembly_discovery',
        failureType: 'NAVIGATION_ERROR',
        errorMessage: err.message,
        url: modelUrl,
      });
      return [];
    }

    const assemblies = await page.evaluate((currentUrl) => {
      const links = Array.from(document.querySelectorAll('a'));
      const results = [];
      const seen = new Set();

      for (const a of links) {
        if (
          a.href.startsWith(currentUrl) &&
          a.href !== currentUrl &&
          !a.href.includes('#') &&
          !a.href.includes('?')
        ) {
          const name = a.textContent.trim();
          if (name && !seen.has(a.href)) {
            seen.add(a.href);
            results.push({ name, url: a.href });
          }
        }
      }
      return results;
    }, modelUrl);

    return this.limitAssemblies
      ? assemblies.slice(0, this.limitAssemblies)
      : assemblies;
  }

  /**
   * Extract diagram image URL and subparts table from an assembly
   */
  async extractAssemblyDetails(page, assemblyUrl, contextMeta) {
    await this.engine.safeGoto(page, assemblyUrl, {}, this.tag);

    try {
      await page.waitForSelector('table tbody tr', { timeout: 3500 });
    } catch {}

    const result = await page.evaluate(extractAssemblyData, { ...contextMeta, assemblyUrl });
    return result;
  }
}
