// Fails if browser-delivered JavaScript/CSS contains server-only secrets.
// Run after `npm run build`. Prints file names and rule names only, never
// matched values.
//
// Checks:
//   1. names of server-only variables (a sign that server config was bundled)
//   2. credential-shaped strings (Google API keys, Resend keys, Razorpay
//      secrets/keys, database URLs, private keys)
//   3. the actual values of server-only variables in the local .env files,
//      when present (so a real secret can't slip in under another name)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticDir = path.join(root, ".next", "static");
if (!fs.existsSync(staticDir)) {
  console.error("No .next/static directory. Run `npm run build` first.");
  process.exit(2);
}

const SERVER_ONLY = [
  "SESSION_SECRET", "DATABASE_URL", "DB_PASSWORD", "RESEND_API_KEY", "SMTP_URL",
  "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "GOOGLE_MAPS_API_KEY",
  "GOOGLE_CLIENT_SECRET", "APPLE_PRIVATE_KEY", "API_INTERNAL_URL",
];
const SHAPES = {
  "google-api-key": /AIza[0-9A-Za-z_-]{35}/,
  "resend-api-key": /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/,
  "razorpay-key-id": /rzp_(test|live)_[A-Za-z0-9]{8,}/,
  "postgres-url": /postgres(ql)?:\/\/[^\s"'`]+@/,
  "private-key": /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
};

const secretValues = [];
for (const file of [path.join(root, "..", ".env"), path.join(root, "..", "backend", ".env")]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && SERVER_ONLY.includes(m[1]) && m[2].length >= 8 && m[1] !== "API_INTERNAL_URL") secretValues.push({ name: m[1], value: m[2] });
  }
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(js|css|json|txt|html)$/.test(entry.name)) files.push(p);
  }
};
walk(staticDir);

const findings = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file);
  for (const name of SERVER_ONLY) if (text.includes(name)) findings.push(`${rel}: mentions server-only variable ${name}`);
  for (const [rule, re] of Object.entries(SHAPES)) if (re.test(text)) findings.push(`${rel}: credential-shaped string (${rule})`);
  for (const { name, value } of secretValues) if (text.includes(value)) findings.push(`${rel}: contains the local value of ${name}`);
}

if (findings.length) {
  console.error(`Client bundle check FAILED (${findings.length}):\n  ${findings.join("\n  ")}`);
  process.exit(1);
}
console.log(`Client bundle check passed: ${files.length} files, ${SERVER_ONLY.length} variable names, ${Object.keys(SHAPES).length} credential shapes, ${secretValues.length} local secret values.`);
