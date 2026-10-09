import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const a = require("archiver");

console.log("=== FULL DEBUG ===");
console.log("typeof a         :", typeof a);
console.log("a.default        :", typeof a.default);
console.log("a.create         :", typeof a.create);
console.log("a keys           :", Object.keys(a));
console.log("a.default keys   :", a.default ? Object.keys(a.default) : "N/A");
console.log("a.toString()     :", Object.prototype.toString.call(a));

// Try all candidates
console.log("\n=== TESTING CANDIDATES ===");
[["a", a], ["a.default", a.default], ["a.create", a.create]].forEach(([name, fn]) => {
  if (typeof fn === "function") {
    try {
      const z = fn("zip", { zlib: { level: 9 } });
      console.log("✅ WORKS:", name, "→", z.constructor.name);
    } catch (e) {
      console.log("❌ FAIL :", name, "→", e.message);
    }
  } else {
    console.log("⏭ SKIP :", name, "→", typeof fn);
  }
});