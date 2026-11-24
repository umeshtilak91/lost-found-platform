"use strict";

// One-time, idempotent backfill for prototype uploads (items.image pointing
// at a file in ./uploads). Each referenced file is decoded and re-encoded like
// a new upload; anything that is not a valid image (e.g. an uploaded HTML
// file) is skipped and never becomes reachable. Original files are left in
// place so nothing referenced by existing items is lost.

const fs = require("fs/promises");
const path = require("path");
const { processImage } = require("./services/images");

async function backfillLegacyImages({ pool, storage, config, logger }) {
  const { rows } = await pool.query(
    `SELECT i.id, i.image FROM items i
     WHERE i.image IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM item_images img WHERE img.item_id = i.id AND img.legacy_file = i.image)`
  );
  const summary = { converted: 0, missing: 0, rejected: 0 };
  for (const row of rows) {
    const file = path.join(config.storage.legacyUploadsDir, path.basename(row.image));
    let buffer;
    try {
      buffer = await fs.readFile(file);
    } catch {
      summary.missing += 1;
      logger.warn({ itemId: row.id }, "Legacy image file not found; skipping");
      continue;
    }
    let processed;
    try {
      processed = await processImage(buffer, config.uploads);
    } catch {
      summary.rejected += 1;
      logger.warn({ itemId: row.id }, "Legacy upload is not a valid image; it will not be served");
      continue;
    }
    const key = `items/legacy-${row.id}-${path.basename(row.image).replace(/[^a-z0-9]/gi, "").slice(0, 40)}`;
    const storageKey = `${key}.webp`;
    const thumbKey = `${key}_thumb.webp`;
    try {
      await storage.put(storageKey, processed.full, "image/webp");
      await storage.put(thumbKey, processed.thumb, "image/webp");
    } catch (error) {
      if (error.code !== "EEXIST" && error.name !== "PreconditionFailed") throw error;
    }
    await pool.query(
      `INSERT INTO item_images (item_id, storage_key, thumb_key, width, height, position, legacy_file)
       VALUES ($1, $2, $3, $4, $5, 0, $6) ON CONFLICT (storage_key) DO NOTHING`,
      [row.id, storageKey, thumbKey, processed.width, processed.height, row.image]
    );
    summary.converted += 1;
  }
  if (rows.length) logger.info(summary, "Legacy image backfill finished");
  return summary;
}

module.exports = { backfillLegacyImages };
