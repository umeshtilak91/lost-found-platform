"use strict";
// Syntax-checks every backend source file (no transpile step to catch it).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const roots = ["server.js", "src", "scripts", "test"];
const files = [];
const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).forEach((f) => walk(path.join(p, f))) : p.endsWith(".js") && files.push(p));
roots.filter(fs.existsSync).forEach(walk);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`Syntax OK (${files.length} files)`);
