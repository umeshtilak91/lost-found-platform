"use strict";

const { z } = require("zod");
const { HttpError } = require("../middleware/errors");
const { itemLocationShape, latitude, longitude, radiusKm, distanceClauses } = require("./locations");

const CATEGORIES = ["phone", "electronics", "wallet", "bag", "keys", "documents", "jewelry", "clothing", "pet", "other"];
const TYPES = ["lost", "found"];
const STATUSES = ["open", "claimed", "returned", "closed"];

// Reporter-driven status transitions. open -> claimed happens only by
// accepting a claim (see routes/claims.js).
// "returned" is reached only through the owner's receipt confirmation
// (services/returns.js); self-recovery and external returns have their own
// actions. Plain closing is reversible; recovery closures need a correction.
const TRANSITIONS = {
  open: ["closed"],
  claimed: ["open", "closed"],
  closed: ["open"],
  returned: [],
};

const ITEM_SELECT = `
  SELECT i.*, u.name AS user_name
  FROM items i LEFT JOIN users u ON u.id = i.user_id`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Not a real date");

// --- Search ----------------------------------------------------------------
const searchSchema = z
  .object({
    type: z.enum(TYPES).optional(),
    q: z.string().trim().max(100).optional(),
    category: z.enum(CATEGORIES).optional(),
    status: z.enum([...STATUSES, "active", "all"]).default("active"),
    from: dateString.optional(),
    to: dateString.optional(),
    location: z.string().trim().max(100).optional(),
    lat: latitude,
    lng: longitude,
    radiusKm,
    sort: z.enum(["newest", "oldest", "date", "distance"]).default("newest"),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "'from' must be on or before 'to'", path: ["from"] })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: "lat and lng must be provided together", path: ["lat"] })
  .refine((v) => v.sort !== "distance" || v.lat !== undefined, { message: "Distance sort needs lat and lng", path: ["sort"] })
  .refine((v) => v.radiusKm === undefined || v.lat !== undefined, { message: "radiusKm needs lat and lng", path: ["radiusKm"] });

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

async function searchItems(db, rawQuery) {
  const query = searchSchema.parse(
    Object.fromEntries(Object.entries(rawQuery).filter(([, value]) => value !== "" && value !== undefined))
  );
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ["i.deleted_at IS NULL", "i.moderation_state = 'visible'"];

  if (query.type) where.push(`i.type = ${add(query.type)}`);
  if (query.status === "active") where.push("i.status IN ('open', 'claimed')");
  else if (query.status !== "all") where.push(`i.status = ${add(query.status)}`);
  if (query.category) where.push(`i.category = ${add(query.category)}`);
  if (query.from) where.push(`i.date >= ${add(query.from)}`);
  if (query.to) where.push(`i.date <= ${add(query.to)}`);
  if (query.location) where.push(`i.location ILIKE ${add(`%${escapeLike(query.location)}%`)}`);
  if (query.q) {
    const term = add(`%${escapeLike(query.q)}%`);
    where.push(`(i.name ILIKE ${term} OR i.location ILIKE ${term} OR i.description ILIKE ${term})`);
  }

  // Distances use the public ~1.1 km grid, never the private coordinates.
  // Radius filters bind their parameters now (they're part of the count);
  // the distance column binds after the count snapshot below.
  if (query.lat !== undefined && query.radiusKm !== undefined) where.push(...distanceClauses(add, query).where);

  const order = {
    newest: "i.created_at DESC, i.id DESC",
    oldest: "i.created_at ASC, i.id ASC",
    date: "i.date DESC, i.id DESC",
    distance: "distance_km ASC NULLS LAST, i.created_at DESC, i.id DESC",
  }[query.sort];

  const whereSql = where.join(" AND ");
  const countParams = [...params];
  const distanceSelect = query.lat !== undefined ? distanceClauses(add, { lat: query.lat, lng: query.lng }).select : "NULL::float AS distance_km";
  const offset = (query.page - 1) * query.pageSize;
  const limitParam = add(query.pageSize);
  const offsetParam = add(offset);

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT i.*, u.name AS user_name, ${distanceSelect}
       FROM items i LEFT JOIN users u ON u.id = i.user_id
       WHERE ${whereSql} ORDER BY ${order} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    ),
    db.query(`SELECT count(*)::int AS total FROM items i WHERE ${whereSql}`, countParams),
  ]);

  const total = count.rows[0].total;
  return {
    query,
    rows: rows.rows,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

// --- Loading and visibility -------------------------------------------------
async function imagesFor(db, itemIds) {
  if (itemIds.length === 0) return new Map();
  const { rows } = await db.query(
    "SELECT id, item_id, width, height FROM item_images WHERE item_id = ANY($1) ORDER BY item_id, position, id",
    [itemIds]
  );
  const byItem = new Map();
  for (const row of rows) {
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
    byItem.get(row.item_id).push(row);
  }
  return byItem;
}

function parseId(value, label = "ID") {
  if (!/^\d{1,12}$/.test(String(value))) throw new HttpError(400, `${label} must be a positive number`, "invalid_id");
  return Number(value);
}

async function loadItem(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(
    forUpdate ? "SELECT * FROM items WHERE id = $1 FOR UPDATE" : `${ITEM_SELECT} WHERE i.id = $1`,
    [id]
  );
  return rows[0] || null;
}

function isModerator(user) {
  return Boolean(user && ["moderator", "admin"].includes(user.role));
}

// Returns the item if the viewer may see it, otherwise throws 404/410.
// Deleted listings are gone for everyone. Moderator-removed listings remain
// visible only to their owner and to moderators.
function assertVisible(item, user) {
  if (!item || item.deleted_at) throw new HttpError(404, "This listing does not exist or was deleted", "item_not_found");
  if (item.moderation_state !== "visible" && !(user && (user.id === item.user_id || isModerator(user)))) {
    if (item.moderation_state === "pending") throw new HttpError(404, "This listing is waiting for review", "item_pending");
    throw new HttpError(410, "This listing was removed for violating our guidelines", "item_removed");
  }
  return item;
}

function assertOwner(item, user) {
  if (!item || item.deleted_at) throw new HttpError(404, "This listing does not exist or was deleted", "item_not_found");
  if (!user || item.user_id !== user.id) throw new HttpError(403, "Only the person who posted this listing can do that", "forbidden");
  return item;
}

// --- Create / update input --------------------------------------------------
function itemInputSchema({ partial }) {
  const shape = {
    type: z.enum(TYPES),
    title: z.string().trim().min(2, "Title is too short").max(120),
    category: z.enum(CATEGORIES),
    description: z.string().trim().max(2000),
    location: z.string().trim().min(2, "Location is too short").max(200),
    date: dateString.refine((value) => value <= today(), "Date cannot be in the future"),
    ...itemLocationShape,
    ownershipQuestion: z.string().trim().max(300),
    acceptRewardTerms: z.preprocess((v) => v === true || v === "true", z.boolean()),
    expectedRewardPaise: z.coerce.number().int().positive(),
    reviewRequested: z.preprocess((v) => v === true || v === "true", z.boolean()),
    removeImageIds: z.preprocess(
      (value) => (Array.isArray(value) ? value : String(value || "").split(",").filter(Boolean)),
      z.array(z.coerce.number().int().positive()).max(20)
    ),
  };
  const optionalKeys = partial
    ? Object.keys(shape)
    : ["description", ...Object.keys(itemLocationShape), "ownershipQuestion", "removeImageIds", "acceptRewardTerms", "expectedRewardPaise", "reviewRequested"];
  const schema = z
    .object(Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, optionalKeys.includes(key) ? value.optional() : value])))
    .strict();
  return schema.refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: "Latitude and longitude must be provided together",
    path: ["latitude"],
  });
}

module.exports = {
  CATEGORIES,
  TYPES,
  STATUSES,
  TRANSITIONS,
  ITEM_SELECT,
  searchItems,
  imagesFor,
  loadItem,
  parseId,
  assertVisible,
  assertOwner,
  isModerator,
  itemInputSchema,
};
