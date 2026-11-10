// Teste per qarkun e proves ne grup CIPBatch: node js/test_batch.mjs
// Kerkon qarqet k2_b1_D24 dhe k2_b3_D11 te kompiluara.
import * as snarkjs from "snarkjs";
import { createHasher, CipTrie, batchInput } from "./trie.mjs";
import { rng } from "./rng.mjs";
import assert from "node:assert/strict";

const LEVELS = { 1: 24, 3: 11 };
const K = 2;

async function accepts(wasm, input) {
  try {
    await snarkjs.wtns.calculate(input, wasm, { type: "mem" });
    return true;
  } catch {
    return false;
  }
}
const bump = (x) => String(BigInt(x) + 1n);
const clone = (o) => JSON.parse(JSON.stringify(o));

const hash = await createHasher();
for (const b of [1, 3]) {
  const D = LEVELS[b];
  const name = `k${K}_b${b}_D${D}`;
  const wasm = `circuits/${name}_js/${name}.wasm`;
  const r = rng(300 + b);
  const trie = new CipTrie(hash, b);
  const keys = Array.from({ length: 512 }, () => r());
  for (const k of keys) trie.insert(k, 5n);

  const next = (i) => {
    for (;;) {
      try { return trie.updateWithWitness(r(), BigInt(50 + i), D).input; } catch { /* shume thelle */ }
    }
  };

  // Grupe te vlefshme te zinxhiruara: perditesim + futje, pastaj dy futje.
  const batches = [];
  let prev = String(trie.root);
  for (let g = 0; g < 4; g++) {
    const txs = g === 0 ? [trie.updateWithWitness(keys[7], 99n, D).input, next(g)] : [next(g), next(g + 10)];
    const input = batchInput(hash, txs);
    assert.equal(input.oldRoot, prev, "zinxhiri i grupeve u keput");
    prev = input.newRoot;
    assert.equal(input.newRoot, String(trie.root));
    assert.ok(await accepts(wasm, input), `grupi i vlefshem ${g} u refuzua`);
    batches.push({ input, txs });
  }

  // Falsifikime: secila duhet te refuzohet.
  const base = batches[1];
  const forgeries = [];
  const forge = (label, edit) => { const x = clone(base.input); edit(x); forgeries.push([label, x]); };
  forge("angazhim i rreme i transaksioneve", (x) => { x.txCommit = bump(x.txCommit); });
  forge("rrenje e re e rreme", (x) => { x.newRoot = bump(x.newRoot); });
  forge("rrenje e vjeter e rreme", (x) => { x.oldRoot = bump(x.oldRoot); });
  forge("rrenje e ndermjetme e rreme", (x) => { x.midRoots[0] = bump(x.midRoots[0]); });
  forge("vlere e ndryshuar ne transaksionin e pare", (x) => { x.newValue[0] = bump(x.newValue[0]); });
  forge("vlere e ndryshuar ne transaksionin e fundit", (x) => { x.newValue[K - 1] = bump(x.newValue[K - 1]); });
  forge("celes i ndryshuar", (x) => { x.keyLo[0] = bump(x.keyLo[0]); });
  forge("radhe e kembyer e transaksioneve", (x) => {
    for (const f of ["keyHi", "keyLo", "newValue", "oldValue", "otherPath", "otherValue", "isUpdate", "isPush", "children", "activeOld", "activeNew"]) {
      x[f].reverse();
    }
  });
  forge("i njejti angazhim, transaksion i dyte i zevendesuar", (x) => {
    const other = batches[2].input;
    for (const f of ["keyHi", "keyLo", "newValue"]) x[f][1] = other[f][1];
  });
  forge("transaksion i hequr (i perseritur i pari)", (x) => {
    for (const f of ["keyHi", "keyLo", "newValue", "oldValue", "otherPath", "otherValue", "isUpdate", "isPush", "children", "activeOld", "activeNew"]) {
      x[f][1] = clone(x[f][0]);
    }
  });
  let rejected = 0;
  for (const [label, x] of forgeries) {
    assert.ok(!(await accepts(wasm, x)), `falsifikimi u pranua: ${label} (aritet ${1 << b})`);
    rejected++;
  }
  // angazhimi varet nga radha
  const swapped = batchInput(hash, [
    { ...base.txs[0], oldRoot: "0", newRoot: "1" },
    { ...base.txs[1], oldRoot: "1", newRoot: "2" },
  ]).txCommit;
  const reversed = batchInput(hash, [
    { ...base.txs[1], oldRoot: "0", newRoot: "1" },
    { ...base.txs[0], oldRoot: "1", newRoot: "2" },
  ]).txCommit;
  assert.notEqual(swapped, reversed);
  assert.equal(swapped, base.input.txCommit);
  console.log(`ok  grup K=${K}, aritet ${1 << b}, D=${D}: ${batches.length} grupe te vlefshme te zinxhiruara; ${rejected} falsifikime te refuzuara`);
}
process.exit(0);
