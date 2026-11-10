// Teste dhe matje per pemen CIP-MPT me Poseidon real (circomlibjs).
//   node js/test.mjs [log2N]
import { createHasher, CipTrie, verifyProof, circuitInput } from "./trie.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { rng } from "./rng.mjs";

// Nivelet fikse te qarkut per cdo aritet (b bit per nivel): 32, 16, 11 nivele = 32-33 bit shtegu.
const CIRCUIT_LEVELS = { 1: 32, 2: 16, 3: 11 };

const hash = await createHasher();

// 1. Vektor testimi i njohur i circomlib: Poseidon(1, 2).
assert.equal(
  hash([1n, 2n]),
  7853200120776062878684798364095072458815029376092732009249414926327459813530n,
  "Poseidon(1,2) nuk perputhet me vektorin e circomlib",
);
console.log("ok  Poseidon(1,2) perputhet me vektorin e circomlib");

// 2. Korrektesia per cdo aritet.
for (const b of [1, 2, 3]) {
  const r = rng(7);
  const items = Array.from({ length: 300 }, () => [r(), r() >> 8n]);
  const t1 = new CipTrie(hash, b), t2 = new CipTrie(hash, b);
  for (const [k, v] of items) t1.insert(k, v);
  for (const [k, v] of [...items].reverse()) t2.insert(k, v);
  assert.equal(t1.root, t2.root, "rrenja varet nga radha");
  for (const [k, v] of items) {
    const p = t1.prove(k);
    assert.equal(p.value, v);
    assert.ok(verifyProof(hash, t1.root, p));
    assert.ok(!verifyProof(hash, t1.root, { ...p, value: v + 1n }));
  }
  assert.equal(t1.prove(r()), null);
  const [k0] = items[0];
  const before = t1.root;
  t1.insert(k0, 123n);
  assert.notEqual(t1.root, before);
  assert.equal(t1.size, 300);
  assert.ok(verifyProof(hash, t1.root, t1.prove(k0)));
  console.log(`ok  aritet ${1 << b}: rrenje e pavarur nga radha, 300 deshmi te vlefshme, falsifikimi refuzohet, perditesimi punon`);
}

// 3. Thellesia me Poseidon real kundrejt formules E[D] = sum_{d>=0} [1 - (1 - A^-d)^(N-1)].
const e = Number(process.argv[2] ?? 13);
const N = 2 ** e;
const expDepth = (n, A) => {
  let s = 1;
  for (let d = 1; d < 200; d++) s += 1 - (1 - A ** -d) ** (n - 1);
  return s;
};
const r = rng(2026);
const keys = Array.from({ length: N }, () => r());
mkdirSync("build", { recursive: true });
console.log(`\nN = 2^${e} = ${N} celesa`);
console.log("aritet | nivele mes. (matur / formula) | nivele max | heshe per futje | mikrosek. per futje");
const tries = {};
for (const b of [1, 2, 3]) {
  const trie = (tries[b] = new CipTrie(hash, b));
  hash.count = 0;
  const t0 = performance.now();
  for (const k of keys) trie.insert(k, 1n);
  const tIns = performance.now() - t0;
  const insHashes = hash.count;
  let tot = 0, max = 0;
  for (const k of keys) {
    const d = trie.prove(k).levels.length;
    tot += d; if (d > max) max = d;
  }
  console.log(
    `${String(1 << b).padStart(6)} | ${(tot / N).toFixed(3).padStart(10)} / ${expDepth(N, 1 << b).toFixed(3).padEnd(10)}      | ` +
    `${String(max).padStart(10)} | ${(insHashes / N).toFixed(1).padStart(15)} | ${(tIns / N * 1000).toFixed(0)}`,
  );
  // hyrje per qarkun: nje celes me deshmi brenda niveleve fikse
  const D = CIRCUIT_LEVELS[b];
  const key = keys.find((k) => trie.prove(k).levels.length <= D);
  writeFileSync(`build/input_b${b}.json`, JSON.stringify(circuitInput(trie.root, trie.prove(key), D)));
}

// 4. Prova ne grup (peme binare): nyje te ndryshme ne bashkimin e m shtigjeve.
console.log("\nProva ne grup, peme binare (m celesa te rastit):");
console.log("     m | nyje te ndara | nyje ne bashkim | kursimi | formula e bashkimit");
for (const m of [1, 16, 128, 1024].filter((x) => x <= N / 4)) {
  const set = new Set();
  let sep = 0;
  for (let i = 0; i < m; i++) {
    const pos = tries[1].pathPositions(keys[(i * 7919) % N]);
    sep += pos.length;
    for (const p of pos) set.add(p);
  }
  let f = 0;
  const L = expDepth(N, 2);
  for (let d = 0; d < Math.ceil(L); d++) {
    f += Math.min(1, L - d) * Math.min(m, 2 ** d * (1 - (1 - 2 ** -d) ** m));
  }
  console.log(`${String(m).padStart(6)} | ${String(sep).padStart(13)} | ${String(set.size).padStart(15)} | ${(100 * (1 - set.size / sep)).toFixed(1).padStart(6)}% | ${f.toFixed(0)}`);
}
console.log("\nbuild/input_b1.json, input_b2.json, input_b3.json u shkruan");
