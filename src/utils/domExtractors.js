/**
 * Client-side evaluation helper for extracting assembly diagram and parts table data.
 * Designed to run directly inside Playwright's `page.evaluate()`.
 *
 * Handles:
 * - Diagram image resolution
 * - DOM table parsing
 * - Server-side rendering (SSR) script fallback for MAP / "Sign in to see price" items
 *
 * @param {object} meta Context metadata (manufacturer, category, year, modelName, assemblyName, assemblyUrl, etc.)
 * @returns {Array<object>} Extracted parts array
 */
export function extractAssemblyData(meta) {
  // 1. Resolve Diagram Image
  let diagramUrl = '';
  const images = Array.from(document.querySelectorAll('img'));

  for (const img of images) {
    const src = img.src || img.getAttribute('data-src') || '';
    const alt = (img.alt || '').toLowerCase();
    const isExcluded =
      src.includes('logo') ||
      src.includes('icon') ||
      src.includes('favicon') ||
      src.includes('badge') ||
      src.includes('star') ||
      src.includes('avatar');

    if (!isExcluded) {
      if (
        src.includes('/OT') ||
        src.includes('/MTE/') ||
        src.includes('diagram') ||
        src.includes('cdn-cgi/image') ||
        src.includes('cdn.partzilla.com') ||
        alt.includes((meta.assemblyName || '').toLowerCase()) ||
        img.clientWidth > 300
      ) {
        diagramUrl = src;
        break;
      }
    }
  }

  if (!diagramUrl) {
    const possible = images.find((i) => {
      const s = i.src || i.getAttribute('data-src') || '';
      return (
        s.includes('cdn.partzilla.com') &&
        !s.includes('logo') &&
        !s.includes('icon') &&
        !s.includes('favicon')
      );
    });
    if (possible) {
      diagramUrl = possible.src || possible.getAttribute('data-src');
    }
  }

  // 2. Extract embedded SSR / Next.js hydration payload for MAP (Minimum Advertised Price) products
  const catalogMap = {};
  try {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const text = s.textContent || '';
      const startKey = 'catalogProduct';
      const keyIdx = text.indexOf(startKey);
      if (keyIdx === -1) continue;

      const openBracketIdx = text.indexOf('[', keyIdx);
      if (openBracketIdx === -1) continue;

      let depth = 0;
      let inString = false;
      let quoteChar = '';
      let isEscaped = false;
      let closeBracketIdx = -1;

      for (let i = openBracketIdx; i < text.length; i++) {
        const char = text[i];
        if (isEscaped) {
          isEscaped = false;
          continue;
        }
        if (char === '\\') {
          isEscaped = true;
          continue;
        }
        if (inString) {
          if (char === quoteChar) inString = false;
        } else {
          if (char === '"' || char === "'") {
            inString = true;
            quoteChar = char;
          } else if (char === '[') {
            depth++;
          } else if (char === ']') {
            depth--;
            if (depth === 0) {
              closeBracketIdx = i;
              break;
            }
          }
        }
      }

      if (closeBracketIdx !== -1) {
        const arrayStr = text.slice(openBracketIdx, closeBracketIdx + 1);
        let parsedArray = null;
        try {
          parsedArray = JSON.parse(arrayStr);
        } catch {
          try {
            const unescaped = arrayStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            parsedArray = JSON.parse(unescaped);
          } catch {}
        }

        if (Array.isArray(parsedArray)) {
          for (const item of parsedArray) {
            if (item && item.sku) {
              const numPrice =
                typeof item.rawPrice === 'number' && item.rawPrice > 0
                  ? item.rawPrice
                  : typeof item.priceDisplay === 'number' && item.priceDisplay > 0
                  ? item.priceDisplay
                  : null;

              let numMsrp = null;
              if (typeof item.priceMsrp === 'number' && item.priceMsrp > 0) {
                numMsrp = item.priceMsrp;
              } else if (item.priceFormattedMsrp) {
                const match = item.priceFormattedMsrp.match(/[\d.,]+/);
                if (match) {
                  const val = parseFloat(match[0].replace(/,/g, ''));
                  if (val > 0) numMsrp = val;
                }
              }

              catalogMap[item.sku] = {
                price: numPrice,
                msrp: numMsrp,
                priceFormattedDisplay: (item.priceFormattedDisplay || '').replace(/^\$+/, '$'),
                priceFormattedMsrp: (item.priceFormattedMsrp || '').replace(/^\$+/, '$'),
              };
            }
          }
        }
      }
    }
  } catch {
    // Fail silently on script parsing and rely on DOM extraction
  }

  // 3. Extract subparts from table rows
  const rows = Array.from(document.querySelectorAll('table tbody tr'));
  const items = [];

  for (const row of rows) {
    const refEl = row.querySelector('[data-column-index="1"], td:nth-child(2)');
    const nameEl = row.querySelector('[data-testid="diagramTableProductName"], a');
    const skuEl = row.querySelector('[data-testid="diagramTableProductPartName"], [role="textbox"]');
    const priceEl = row.querySelector('[data-testid="productPrice"], .price');
    const msrpEl = row.querySelector('[data-testid="productPriceValue"]');
    const stockEl = row.querySelector('[data-testid="stockInfoText"], [data-slot="stock-label"]');
    const col3El = row.querySelector('[data-column-index="3"], td:nth-child(4)');
    const col3Text = col3El ? col3El.textContent.trim() : '';

    const refNumber = refEl ? refEl.textContent.trim().replace(/^#\s*/, '') : '';
    const partName = nameEl ? nameEl.textContent.trim() : '';
    const sku = skuEl ? skuEl.textContent.trim() : '';
    const productPath = nameEl ? nameEl.getAttribute('href') : '';
    const productUrl = productPath
      ? productPath.startsWith('http')
        ? productPath
        : `https://www.partzilla.com${productPath}`
      : '';

    let priceRaw = priceEl ? priceEl.textContent.trim() : '';
    let msrpRaw = msrpEl ? msrpEl.textContent.trim() : '';

    // If priceEl wasn't found by testid, check col3 for price text like $XX.XX
    if (!priceRaw && col3Text.includes('$')) {
      const dollarMatch = col3Text.match(/\$[\d,]+(\.\d{2})?/);
      if (dollarMatch) {
        priceRaw = dollarMatch[0];
      }
    }

    // Determine availability
    let stock = 'In Stock';
    if (stockEl) {
      stock = stockEl.textContent.trim();
    } else if (
      col3Text.toLowerCase().includes('unavailable') ||
      row.textContent.toLowerCase().includes('unavailable')
    ) {
      stock = 'Unavailable';
    } else if (
      col3Text.toLowerCase().includes('discontinued') ||
      partName.toLowerCase().includes('discontinued') ||
      row.textContent.toLowerCase().includes('discontinued')
    ) {
      stock = 'Discontinued';
    } else if (col3Text.toLowerCase().includes('backorder')) {
      stock = 'Backordered';
    } else if (!priceRaw && !col3Text.includes('$')) {
      stock = col3Text || 'Unavailable';
    }

    const priceMatch = priceRaw.match(/[\d.,]+/);
    let price = priceMatch ? parseFloat(priceMatch[0].replace(/,/g, '')) : null;
    if (price === 0) price = null; // $0.00 is never a valid retail price for OEM parts

    const msrpMatch = msrpRaw.match(/[\d.,]+/);
    let msrp = msrpMatch ? parseFloat(msrpMatch[0].replace(/,/g, '')) : null;
    if (msrp === 0) msrp = null;

    // Fallback to embedded catalog payload if prices were masked (e.g. MAP / "Sign in to see price")
    const catalogInfo = catalogMap[sku];
    if (catalogInfo) {
      if (price === null && catalogInfo.price !== null && catalogInfo.price > 0) {
        price = catalogInfo.price;
        priceRaw = catalogInfo.priceFormattedDisplay || `$${price.toFixed(2)}`;
      }
      if (msrp === null && catalogInfo.msrp !== null && catalogInfo.msrp > 0) {
        msrp = catalogInfo.msrp;
        msrpRaw = catalogInfo.priceFormattedMsrp || `$${msrp.toFixed(2)}`;
      }
    }

    // If item is Unavailable or Discontinued and has no real price, ensure price is null and priceRaw is empty
    if (stock === 'Unavailable' || stock === 'Discontinued') {
      if (!price || price <= 0) {
        price = null;
        priceRaw = '';
      }
    }

    if (partName || sku) {
      items.push({
        manufacturer: meta.manufacturer,
        category: meta.category,
        year: meta.year,
        modelName: meta.modelName,
        modelUrl: meta.modelUrl,
        assemblyName: meta.assemblyName,
        assemblyUrl: meta.assemblyUrl,
        diagramImageUrl: diagramUrl,
        refNumber,
        partName,
        sku,
        priceRaw,
        price,
        msrp,
        availability: stock,
        productUrl,
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  return {
    parts: items,
    diagramImageUrl: diagramUrl,
    rawRowCount: rows.length,
    hasTable: Boolean(document.querySelector('table')),
    pageTitle: document.title || '',
  };
}
