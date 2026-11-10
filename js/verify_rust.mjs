// Verifikon me snarkjs provat e prodhuara nga provuesi ne Rust: node js/verify_rust.mjs <emri>...
import * as snarkjs from "snarkjs";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
for (const name of process.argv.slice(2)) {
  const vkey = read(`build/${name}_vkey.json`);
  const proof = read(`build/${name}_rust_proof.json`);
  const pub = read(`build/${name}_rust_public.json`);
  assert.deepEqual(pub, read(`build/${name}_public.json`), `${name}: hyrjet publike te Rust ndryshojne nga snarkjs`);
  assert.ok(await snarkjs.groth16.verify(vkey, pub, proof), `${name}: prova e Rust u refuzua nga snarkjs`);
  const forged = pub.slice();
  forged[0] = String(BigInt(forged[0]) + 1n);
  assert.ok(!(await snarkjs.groth16.verify(vkey, forged, proof)), `${name}: prova e Rust u pranua me hyrje te rreme`);
  console.log(`ok  ${name}: prova e Rust pranohet nga snarkjs; hyrja e rreme refuzohet`);
}
process.exit(0);
