// Teste dhe matje per qarkun e perditesimit CIPUpdate.
//   node js/test_update.mjs          teste (llogaritje deshmitari + falsifikime)
//   node js/test_update.mjs --prove  edhe setup/prove/verify Groth16
import * as snarkjs from "snarkjs";
import { createHasher, CipTrie } from "./trie.mjs";
import assert from "node:assert/strict";
import { rng } from "./rng.mjs";
import { ensurePtau, ensureZkey } from "./setup.mjs";

const LEVELS = { 1: 24, 2: 16, 3: 11 };
const prove = process.argv.includes("--prove");

// Qarku pranon hyrjen vetem nese te gjitha kufizimet plotesohen.
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
const rows = [];
for (const b of [1, 2, 3]) {
  const D = LEVELS[b];
  const name = `u_b${b}_D${D}`;
  const wasm = `circuits/${name}_js/${name}.wasm`;
  const r = rng(100 + b);
  const trie = new CipTrie(hash, b);

  // Peme fillestare: 512 celesa (pa deshmitar).
  const keys = Array.from({ length: 512 }, () => r());
  for (const k of keys) trie.insert(k, 5n);

  // Mbledh nga nje kalim per secilen menyre; cdo kalim i pranuar zinxhirohet me rrenjen e meparshme.
  const seen = {};
  let prevRoot = trie.root, checked = 0;
  const check = async (w) => {
    assert.equal(w.input.oldRoot, String(prevRoot), "zinxhiri i rrenjeve u keput");
    prevRoot = trie.root;
    assert.ok(await accepts(wasm, w.input), `kalimi i vlefshem (${w.mode}) u refuzua`);
    checked++;
    seen[w.mode] ??= w;
  };
  await check(trie.updateWithWitness(keys[3], 77n, D));          // update
  for (let i = 0; i < 400 && !(seen.empty && seen.push && checked >= 12); i++) {
    let w;
    try { w = trie.updateWithWitness(r(), BigInt(i + 1), D); } catch { prevRoot = trie.root; continue; }
    await check(w);
  }
  assert.ok(seen.update && seen.empty && seen.push, "nuk u pane te tria menyrat");

  // Peme bosh: futja e pare.
  const fresh = new CipTrie(hash, b);
  const w0 = fresh.updateWithWitness(r(), 9n, D);
  assert.equal(w0.input.oldRoot, "0");
  assert.ok(await accepts(wasm, w0.input), "futja ne peme bosh u refuzua");

  // Falsifikime: secila duhet te refuzohet.
  const forgeries = [];
  const forge = (label, base, edit) => { const x = clone(base.input); edit(x); forgeries.push([label, x]); };
  forge("rrenje e re e rreme", seen.update, (x) => { x.newRoot = bump(x.newRoot); });
  forge("rrenje e vjeter e rreme", seen.update, (x) => { x.oldRoot = bump(x.oldRoot); });
  forge("vlere e vjeter e rreme", seen.update, (x) => { x.oldValue = bump(x.oldValue); });
  forge("update i paraqitur si futje ne vend bosh", seen.update, (x) => { x.isUpdate = "0"; });
  forge("futje ne vend bosh e paraqitur si update", seen.empty, (x) => { x.isUpdate = "1"; });
  forge("vlere e re tjeter me te njejten rrenje", seen.empty, (x) => { x.newValue = bump(x.newValue); });
  forge("gjethja tjeter me vlere te ndryshuar", seen.push, (x) => { x.otherValue = bump(x.otherValue); });
  forge("gjethja tjeter me shteg te ndryshuar", seen.push, (x) => { x.otherPath = bump(x.otherPath); });
  forge("shtyrje pa nivele zgjatimi", seen.push, (x) => { x.activeNew = x.activeOld.slice(); });
  forge("shtyrje e paraqitur si vend bosh", seen.push, (x) => { x.isPush = "0"; });
  forge("gjethja tjeter hiqet nga niveli i fundit", seen.push, (x) => {
    const last = x.activeNew.lastIndexOf("1");
    x.children[last] = x.children[last].map(() => "0");
  });
  forge("nje nivel zgjatimi me shume", seen.push, (x) => {
    const d = x.activeNew.indexOf("0");
    if (d >= 0) x.activeNew[d] = "1";
  });
  forge("vella i ndryshuar ne pemen e vjeter", seen.empty, (x) => {
    if (x.activeOld[0] === "1") x.children[0] = x.children[0].map(bump);
    else x.newRoot = bump(x.newRoot);
  });
  let rejected = 0;
  for (const [label, x] of forgeries) {
    const ok = await accepts(wasm, x);
    assert.ok(!ok, `falsifikimi u pranua: ${label} (aritet ${1 << b})`);
    rejected++;
  }
  console.log(`ok  aritet ${1 << b}, D=${D}: ${checked + 1} kalime te vlefshme te pranuara (update, vend bosh, shtyrje, peme bosh); ${rejected} falsifikime te refuzuara`);

  if (prove) {
    const zkey = await ensureZkey(name, await ensurePtau(14));
    const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
    const info = await snarkjs.r1cs.info(`circuits/${name}.r1cs`);
    const times = [];
    let proof, publicSignals;
    for (const mode of ["update", "empty", "push", "update", "push"]) {
      const t0 = performance.now();
      ({ proof, publicSignals } = await snarkjs.groth16.fullProve(seen[mode].input, wasm, zkey));
      times.push(performance.now() - t0);
    }
    const tv = performance.now();
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    const tVer = performance.now() - tv;
    const forged = publicSignals.slice();
    forged[1] = bump(forged[1]); // newRoot tjeter
    const bad = await snarkjs.groth16.verify(vkey, forged, proof);
    assert.ok(ok && !bad);
    rows.push(`${String(1 << b).padStart(6)} | ${String(D).padStart(6)} | ${String(info.nConstraints).padStart(8)} | ` +
      `${(Math.min(...times) / 1000).toFixed(2)} s / ${(times.reduce((x, y) => x + y) / times.length / 1000).toFixed(2)} s | ${tVer.toFixed(0)} ms`);
  }
}
if (prove) {
  console.log("\naritet | nivele | kufizime | prove min / mes. | verify");
  for (const row of rows) console.log(row);
}
process.exit(0);
