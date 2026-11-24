"use strict";

// Object storage abstraction. Both adapters expose:
//   put(key, buffer, contentType) -> void
//   get(key) -> { body: Buffer, contentType } | null
//   remove(keys[]) -> void            (best effort, missing keys are ignored)
//   invalidate(keys[]) -> void        (CDN cache purge where configured)
//   healthy() -> boolean

const fs = require("fs/promises");
const path = require("path");

function assertKey(key) {
  if (!/^[a-z0-9][a-z0-9/_-]*\.webp$/i.test(key) || key.includes("..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

function createLocalStorage({ localDir }) {
  const resolve = (key) => {
    assertKey(key);
    const full = path.resolve(localDir, key);
    if (!full.startsWith(path.resolve(localDir) + path.sep)) throw new Error("Storage key escapes root");
    return full;
  };

  return {
    driver: "local",
    async put(key, body) {
      const full = resolve(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, body, { flag: "wx" });
    },
    async get(key) {
      try {
        return { body: await fs.readFile(resolve(key)), contentType: "image/webp" };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(keys) {
      await Promise.all(keys.filter(Boolean).map((key) => fs.rm(resolve(key), { force: true })));
    },
    async invalidate() {},
    async healthy() {
      await fs.mkdir(localDir, { recursive: true });
      await fs.access(localDir, fs.constants.W_OK);
      return true;
    },
  };
}

function createS3Storage({ s3Bucket, s3Region, s3Prefix, cloudfrontDistributionId }, logger) {
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectsCommand,
    HeadBucketCommand,
  } = require("@aws-sdk/client-s3");
  const client = new S3Client({ region: s3Region });
  const fullKey = (key) => {
    assertKey(key);
    return s3Prefix ? `${s3Prefix}/${key}` : key;
  };

  let cloudfront = null;
  if (cloudfrontDistributionId) {
    const { CloudFrontClient, CreateInvalidationCommand } = require("@aws-sdk/client-cloudfront");
    const cf = new CloudFrontClient({ region: "us-east-1" });
    cloudfront = { cf, CreateInvalidationCommand };
  }

  return {
    driver: "s3",
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: s3Bucket,
          Key: fullKey(key),
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
        })
      );
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: s3Bucket, Key: fullKey(key) }));
        return { body: Buffer.from(await out.Body.transformToByteArray()), contentType: "image/webp" };
      } catch (error) {
        if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async remove(keys) {
      const objects = keys.filter(Boolean).map((key) => ({ Key: fullKey(key) }));
      for (let i = 0; i < objects.length; i += 1000) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: s3Bucket, Delete: { Objects: objects.slice(i, i + 1000), Quiet: true } })
        );
      }
    },
    // Image URLs are served by the API (/api/images/...), which CloudFront may
    // cache. Purge those paths when an image becomes inaccessible.
    async invalidate(paths) {
      if (!cloudfront || paths.length === 0) return;
      try {
        await cloudfront.cf.send(
          new cloudfront.CreateInvalidationCommand({
            DistributionId: cloudfrontDistributionId,
            InvalidationBatch: {
              CallerReference: `lf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              Paths: { Quantity: paths.length, Items: paths },
            },
          })
        );
      } catch (error) {
        logger.error({ err: error }, "CloudFront invalidation failed");
      }
    },
    async healthy() {
      await client.send(new HeadBucketCommand({ Bucket: s3Bucket }));
      return true;
    },
  };
}

function createStorage(storageConfig, logger) {
  return storageConfig.driver === "s3"
    ? createS3Storage(storageConfig, logger)
    : createLocalStorage(storageConfig);
}

module.exports = { createStorage };
