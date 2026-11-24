"use strict";

// Image intake: the client-declared MIME type is never trusted. Every upload is
// decoded by libvips, checked for format and dimensions, then re-encoded to
// WebP with all metadata (EXIF/GPS/XMP) dropped. Only the re-encoded output is
// stored, under a server-generated key.

const crypto = require("crypto");
const sharp = require("sharp");
const multer = require("multer");
const { HttpError } = require("../middleware/errors");

const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);

function createUploadMiddleware(uploads) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: uploads.maxFileBytes,
      files: uploads.maxFiles,
      fields: 30,
      fieldSize: 16 * 1024,
      parts: uploads.maxFiles + 30,
    },
  }).array("images", uploads.maxFiles);
}

// Wraps multer so its errors become consistent 400/413 API errors.
function parseUploads(uploads) {
  const middleware = createUploadMiddleware(uploads);
  return (req, res, next) => {
    middleware(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        const messages = {
          LIMIT_FILE_SIZE: `Each image must be ${Math.round(uploads.maxFileBytes / 1024 / 1024)} MB or smaller`,
          LIMIT_FILE_COUNT: `You can upload up to ${uploads.maxFiles} images`,
          LIMIT_UNEXPECTED_FILE: `You can upload up to ${uploads.maxFiles} images using the "images" field`,
        };
        return next(new HttpError(status, messages[error.code] || "Invalid upload", "upload_rejected"));
      }
      return next(error);
    });
  };
}

async function processImage(buffer, uploads) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: uploads.maxPixels, failOn: "error" }).metadata();
  } catch {
    throw new HttpError(400, "One of the files is not a valid JPEG, PNG or WebP image", "invalid_image");
  }
  if (!ALLOWED_FORMATS.has(meta.format)) {
    throw new HttpError(400, "Only JPEG, PNG and WebP images are accepted", "invalid_image");
  }
  const { width = 0, height = 0 } = meta;
  if (
    width < uploads.minDimension ||
    height < uploads.minDimension ||
    width > uploads.maxDimension ||
    height > uploads.maxDimension
  ) {
    throw new HttpError(
      400,
      `Images must be between ${uploads.minDimension} and ${uploads.maxDimension} pixels on each side`,
      "invalid_image"
    );
  }

  try {
    const base = () => sharp(buffer, { limitInputPixels: uploads.maxPixels, pages: 1 }).rotate();
    const full = await base()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await base()
      .resize({ width: 480, height: 360, fit: "cover", position: "attention" })
      .webp({ quality: 75 })
      .toBuffer();
    return { full: full.data, thumb, width: full.info.width, height: full.info.height };
  } catch {
    throw new HttpError(400, "One of the images could not be processed", "invalid_image");
  }
}

// Processes and stores every file. If any step fails, objects written so far
// are removed so a rejected request leaves nothing behind.
async function storeImages(files, { storage, uploads }) {
  const processed = [];
  for (const file of files) processed.push(await processImage(file.buffer, uploads));

  const stored = [];
  try {
    for (const image of processed) {
      const id = crypto.randomUUID();
      const storageKey = `items/${id}.webp`;
      const thumbKey = `items/${id}_thumb.webp`;
      await storage.put(storageKey, image.full, "image/webp");
      stored.push(storageKey);
      await storage.put(thumbKey, image.thumb, "image/webp");
      stored.push(thumbKey);
      Object.assign(image, { storageKey, thumbKey });
    }
  } catch (error) {
    await storage.remove(stored).catch(() => {});
    throw error;
  }
  return {
    images: processed.map(({ storageKey, thumbKey, width, height }) => ({ storageKey, thumbKey, width, height })),
    keys: stored,
  };
}

function imagePaths(imageIds) {
  return imageIds.flatMap((id) => [`/api/images/${id}`, `/api/images/${id}/thumb`]);
}

module.exports = { parseUploads, processImage, storeImages, imagePaths };
