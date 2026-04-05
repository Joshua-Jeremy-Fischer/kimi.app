const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..");
const files = ["server.js", "agent.js", "auth.js"];
const hashes = {};
for (const f of files) {
  const full = path.join(dir, f);
  hashes[f] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}
const out = path.join(dir, ".fim_hashes.json");
fs.writeFileSync(out, JSON.stringify(hashes, null, 2));
console.log("FIM hashes geschrieben:", out);
