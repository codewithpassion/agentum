// biome-ignore-all lint/suspicious/noMisplacedAssertion: this executable is a standalone integration check.
import { strict as assert } from "node:assert/strict";

const r = await fetch("http://localhost:18987");
assert.equal(r.status, 200);
const x = await r.json();
assert.equal(x.dom, "undefined");
assert.equal(x.roundtrip, "# Heading\n\nHello **world**.");
assert.equal(x.tiptapRoundtrip, x.roundtrip);
assert.deepEqual(x.concurrent, [
  "hello human agent world",
  "hello human agent world",
]);
assert.equal(x.snapshotBytes, 5_242_900);
assert.equal(x.chunks, 41);
assert.equal(x.updates, 1);
assert.equal(x.restoredBytes, 5_242_884);
console.log(JSON.stringify(x));
