// Pergatit hyrjet, zkey dhe vkey per qarqe te cfaredoshme (perfshire 248-biteshet):
//   node js/bench_inputs.mjs <fuqia e ptau> <emri>...     p.sh. node js/bench_inputs.mjs 17 m_b1_D248 u_b3_D83
import * as snarkjs from "snarkjs";
import { createHasher, CipTrie, circuitInput, batchInput } from "./trie.mjs";
import { ensurePtau, ensureZkey } from "./setup.mjs";
import { rng } from "./rng.mjs";
import { writeFileSync } from "node:fs";

const [power, ...names] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

log(`powers of tau 2^${power}`);
const ptau = await ensurePtau(Number(power));
log("powers of tau gati");

const hash = await createHasher();
const r = rng(4242);
const keys = Array.from({ length: 4096 }, () => r());
const tries = {};
const info = [];
for (const name of names) {
  const m = name.match(/^(m|u|k\d+)_b(\d)_D(\d+)$/);
  if (!m) throw new Error(`emer i panjohur: ${name}`);
  const [, kind, bs, Ds] = m;
  const b = Number(bs), D = Number(Ds);
  if (!tries[b]) {
    tries[b] = new CipTrie(hash, b);
    for (const k of keys) tries[b].insert(k, 5n);
  }
  const trie = tries[b];
  let input;
  if (kind === "m") {
    input = circuitInput(trie.root, trie.prove(keys[3]), D);
  } else if (kind === "u") {
    input = trie.updateWithWitness(r(), 7n, D).input;
  } else {
    const K = Number(kind.slice(1));
    const txs = [trie.updateWithWitness(keys[5], 8n, D).input];
    while (txs.length < K) txs.push(trie.updateWithWitness(r(), 9n, D).input);
    input = batchInput(hash, txs);
  }
  writeFileSync(`build/${name}_input.json`, JSON.stringify(input));
  const t0 = performance.now();
  const zkey = await ensureZkey(name, ptau);
  const setupS = (performance.now() - t0) / 1000;
  writeFileSync(`build/${name}_vkey.json`, JSON.stringify(await snarkjs.zKey.exportVerificationKey(zkey)));
  const r1cs = await snarkjs.r1cs.info(`circuits/${name}.r1cs`);
  info.push({ emri: name, kufizime: r1cs.nConstraints, setupS: Math.round(setupS) });
  log(JSON.stringify(info.at(-1)));
}
writeFileSync("build/bench_info.json", JSON.stringify(info));
process.exit(0);
