"use strict";

// Lost <-> found matching. Candidates are open, visible listings of the
// opposite type whose event dates are within 30 days. Scores combine
// category, title similarity (pg_trgm), location text similarity, and
// distance when both listings have coordinates.

const MATCH_THRESHOLD = 0.45;

const MATCH_SQL = `
  WITH source AS (SELECT * FROM items WHERE id = $1)
  SELECT
    c.id,
    c.user_id,
    (CASE WHEN c.category = s.category AND s.category <> 'other' THEN 0.35 ELSE 0 END)
      + 0.4 * similarity(lower(c.name), lower(s.name))
      + 0.15 * similarity(lower(c.location), lower(s.location))
      + (CASE WHEN c.latitude IS NOT NULL AND s.latitude IS NOT NULL THEN
           0.1 * GREATEST(0, 1 - (
             6371 * acos(LEAST(1, cos(radians(s.latitude)) * cos(radians(c.latitude))
               * cos(radians(c.longitude) - radians(s.longitude))
               + sin(radians(s.latitude)) * sin(radians(c.latitude))))
           ) / 25)
         ELSE 0 END) AS score
  FROM items c, source s
  WHERE c.type <> s.type
    AND c.id <> s.id
    AND c.status = 'open'
    AND c.deleted_at IS NULL
    AND c.moderation_state = 'visible'
    AND c.user_id IS DISTINCT FROM s.user_id
    AND abs(c.date - s.date) <= 30
    AND (c.category = s.category OR similarity(lower(c.name), lower(s.name)) > 0.2)
  ORDER BY score DESC, c.created_at DESC, c.id DESC
  LIMIT $2`;

async function findMatches(db, itemId, limit = 10) {
  const { rows } = await db.query(MATCH_SQL, [itemId, limit]);
  return rows.filter((row) => Number(row.score) >= MATCH_THRESHOLD);
}

// Notifies both listing owners about each new match. Dedupe keys are built
// from the ordered pair so A->B and B->A share one notification per user.
async function notifyMatches(db, notifier, item) {
  if (item.status !== "open" || item.moderation_state !== "visible" || item.deleted_at) return [];
  const matches = await findMatches(db, item.id, 5);
  const created = [];
  for (const match of matches) {
    const [a, b] = [item.id, match.id].sort((x, y) => x - y);
    const key = `match:${a}:${b}`;
    if (item.user_id) {
      created.push(
        await notifier.notify(db, { userId: item.user_id, type: "match", itemId: item.id, data: { matchItemId: match.id }, dedupeKey: key })
      );
    }
    if (match.user_id) {
      created.push(
        await notifier.notify(db, { userId: match.user_id, type: "match", itemId: match.id, data: { matchItemId: item.id }, dedupeKey: key })
      );
    }
  }
  return created;
}

module.exports = { findMatches, notifyMatches, MATCH_THRESHOLD };
