"use strict";

// Detects contact details in free text that is visible before the ₹100
// connection is paid (public listing text, ownership answers). This is a
// safeguard, not a guarantee: users can still obfuscate (see release notes).

const PATTERNS = [
  { kind: "phone", re: /(?:\+?\d[\s\-().]*){10,}/ }, // 10+ digits with separators
  { kind: "phone", re: /\b[6-9]\d{4}[\s-]?\d{5}\b/ }, // Indian mobile
  { kind: "email", re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
  { kind: "upi", re: /\b[\w.-]{2,}@(?:ok\w+|ybl|ibl|axl|upi|paytm|apl|yapl|ptyes|ptaxis|pthdfc|ptsbi|icici|sbi|hdfcbank|axisbank|kotak|airtel|freecharge|jio)\b/i },
  { kind: "link", re: /\b(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|t\.me|chat\.whatsapp\.com|instagram\.com|facebook\.com|fb\.me)\/\S*/i },
  { kind: "messaging", re: /\b(?:whats\s?app|telegram|insta(?:gram)?\s*id|call\s+me|dm\s+me|ping\s+me)\b/i },
];

function findContactDetails(text) {
  if (!text) return [];
  const found = new Set();
  for (const { kind, re } of PATTERNS) if (re.test(text)) found.add(kind);
  return [...found];
}

// Returns { field: kinds[] } for the given fields that contain contact details.
function scanFields(fields) {
  const hits = {};
  for (const [field, value] of Object.entries(fields)) {
    const kinds = findContactDetails(value);
    if (kinds.length) hits[field] = kinds;
  }
  return hits;
}

module.exports = { findContactDetails, scanFields };
