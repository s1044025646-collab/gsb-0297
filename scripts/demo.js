// demo
const { encodeText, decodeText, explainText } = require("../dist/src/service");
const rocket = String.fromCodePoint(0x1f680);
const face = String.fromCodePoint(0x1f600);
const samples = ["bücher", "mañana", "中文", "a中b文c", face + "emoji" + rocket, "hello"];
for (const s of samples) {
  const enc = encodeText(s, "raw");
  console.log("encode(" + JSON.stringify(s) + ") -> " + enc.output);
  const dec = decodeText(enc.output, "raw");
  console.log("  decode -> " + JSON.stringify(dec.restored) + "  roundtrip: " + (dec.restored === s));
}
console.log("\n--- explain('bücher') ---");
const r = explainText("bücher", "raw");
for (const step of r.steps) {
  if (step.kind === "encode-delta") {
    console.log("encode U+" + step.codePoint.toString(16) + " '" + step.char + "' delta=" + step.delta + " bias=" + step.bias + " out=" + step.output);
  } else {
    console.log("decode delta=" + step.delta + " -> U+" + step.n.toString(16) + " '" + step.char + "' insertAt=" + step.insertPosition + " now=" + step.output);
  }
}
