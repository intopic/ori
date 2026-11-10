// Mat metrikat e tabeles fillestare te studimit ne kete makine dhe shkruan build/results.json.
// Gjeneron edhe kontraten verifikuese dhe testin Foundry per matjen e gazit.
//   node js/claims.mjs
import * as snarkjs from "snarkjs";
import { createHasher, CipTrie, circuitInput } from "./trie.mjs";
import { ensurePtau, ensureZkey } from "./setup.mjs";
import { rng } from "./rng.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const RUNS = 5;
const LOG2N = Number(process.argv[2] ?? 14);
const N = 2 ** LOG2N;
const VARIANTS = [
  { kind: "m", b: 1, D: 20 },  // shkalla e pohimit origjinal: 20 nivele
  { kind: "m", b: 1, D: 32 },
  { kind: "m", b: 3, D: 7 },   // 21 bit shteg, aritet 8
  { kind: "m", b: 3, D: 11 },
  { kind: "u", b: 1, D: 24 },
  { kind: "u", b: 3, D: 11 },
];
const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;

const ptau = await ensurePtau(14);
const hash = await createHasher();
const out = {
  runner: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), node: process.version },
  N,
  tree: {},
  circuits: [],
};

// Pemet (binare dhe tetshe) me N celesa.
const tries = {};
const r = rng(2026);
const keys = Array.from({ length: N }, () => r());
for (const b of [1, 3]) {
  const trie = (tries[b] = new CipTrie(hash, b));
  for (const k of keys) trie.insert(k, 5n);
  const depths = keys.map((k) => trie.prove(k).levels.length);
  out.tree[`aritet${1 << b}`] = {
    niveleMes: +mean(depths).toFixed(3),
    niveleMax: Math.max(...depths),
    // deshmia e papunuar: (aritet - 1) vellezer x 32 bajt per nivel
    deshmiaBajtMes: Math.round(mean(depths) * ((1 << b) - 1) * 32),
  };
}

let gasArtifacts = null;
for (const { kind, b, D } of VARIANTS) {
  const name = `${kind}_b${b}_D${D}`;
  const wasm = `circuits/${name}_js/${name}.wasm`;
  const zkey = await ensureZkey(name, ptau);
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  const info = await snarkjs.r1cs.info(`circuits/${name}.r1cs`);
  const trie = tries[b];

  const inputs = [];
  if (kind === "m") {
    for (const k of keys) {
      const p = trie.prove(k);
      if (p.levels.length <= D) inputs.push(circuitInput(trie.root, p, D));
      if (inputs.length === RUNS) break;
    }
  } else {
    inputs.push(trie.updateWithWitness(keys[1], 9n, D).input);
    while (inputs.length < RUNS) {
      try { inputs.push(trie.updateWithWitness(r(), 3n, D).input); } catch { /* shume thelle per kete D */ }
    }
  }

  const tWit = [], tFull = [];
  let proof, publicSignals;
  for (const input of inputs) {
    let t0 = performance.now();
    await snarkjs.wtns.calculate(input, wasm, { type: "mem" });
    tWit.push(performance.now() - t0);
    t0 = performance.now();
    ({ proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey));
    tFull.push(performance.now() - t0);
  }
  let t0 = performance.now();
  assert.ok(await snarkjs.groth16.verify(vkey, publicSignals, proof), `${name}: prova e vlefshme u refuzua`);
  const verifyMs = performance.now() - t0;
  const forged = publicSignals.slice();
  forged[0] = String(BigInt(forged[0]) + 1n);
  assert.ok(!(await snarkjs.groth16.verify(vkey, forged, proof)), `${name}: prova e rreme u pranua`);

  out.circuits.push({
    emri: name, lloji: kind === "m" ? "anetaresi" : "perditesim", aritet: 1 << b, nivele: D,
    kufizime: info.nConstraints,
    deshmitarMs: Math.round(mean(tWit)),
    proveMinS: +(Math.min(...tFull) / 1000).toFixed(3),
    proveMesS: +(mean(tFull) / 1000).toFixed(3),
    verifyMs: Math.round(verifyMs),
  });
  console.log(JSON.stringify(out.circuits.at(-1)));
  // per provuesin ne Rust: e njejta hyrje, dhe prova e snarkjs per verifikim te kryqezuar
  writeFileSync(`build/${name}_input.json`, JSON.stringify(inputs.at(-1)));
  writeFileSync(`build/${name}_proof.json`, JSON.stringify(proof));
  writeFileSync(`build/${name}_public.json`, JSON.stringify(publicSignals));
  writeFileSync(`build/${name}_vkey.json`, JSON.stringify(vkey));
  if (name === "m_b1_D20") gasArtifacts = { zkey, proof, publicSignals };
}

// Kontrata verifikuese + testi Foundry me nje prove reale.
{
  const require = createRequire(import.meta.url);
  const tpl = path.join(path.dirname(require.resolve("snarkjs")), "..", "templates", "verifier_groth16.sol.ejs");
  const sol = await snarkjs.zKey.exportSolidityVerifier(gasArtifacts.zkey, { groth16: readFileSync(tpl, "utf8") });
  mkdirSync("contracts/src", { recursive: true });
  mkdirSync("contracts/test", { recursive: true });
  writeFileSync("contracts/src/Verifier.sol", sol);

  const call = await snarkjs.groth16.exportSolidityCallData(gasArtifacts.proof, gasArtifacts.publicSignals);
  const [a, bb, c, pub] = JSON.parse(`[${call}]`);
  const lit = (xs) => `[uint256(${xs[0]}), ${xs.slice(1).join(", ")}]`;
  writeFileSync("contracts/test/VerifierGas.t.sol", `// SPDX-License-Identifier: MIT
// SKEDAR I GJENERUAR nga js/claims.mjs - mos e ndryshoni me dore.
pragma solidity ^0.8.20;

import "../src/Verifier.sol";

contract VerifierGasTest {
    event log_named_uint(string key, uint256 val);

    Groth16Verifier internal v;

    function setUp() public {
        v = new Groth16Verifier();
    }

    function _args() internal pure returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[${pub.length}] memory p) {
        a = ${lit(a)};
        b = [${lit(bb[0])}, ${lit(bb[1])}];
        c = ${lit(c)};
        p = ${lit(pub)};
    }

    function testVerifyGas() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[${pub.length}] memory p) = _args();
        uint256 g = gasleft();
        bool ok = v.verifyProof(a, b, c, p);
        uint256 used = g - gasleft();
        require(ok, "prova e vlefshme u refuzua");
        emit log_named_uint("verify_gas", used);
    }

    function testRejectsForgedValue() public view {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[${pub.length}] memory p) = _args();
        p[${pub.length - 1}] += 1;
        require(!v.verifyProof(a, b, c, p), "prova e rreme u pranua");
    }
}
`);
  // gazi i te dhenave te transaksionit: 16 per bajt jozero, 4 per bajt zero, + 4 bajt selektor
  const hex = [a, bb.flat(), c, pub].flat().map((x) => BigInt(x).toString(16).padStart(64, "0")).join("");
  let calldataGas = 4 * 16;
  for (let i = 0; i < hex.length; i += 2) calldataGas += hex.slice(i, i + 2) === "00" ? 4 : 16;
  out.calldata = { bajt: 4 + hex.length / 2, gas: calldataGas };
}

writeFileSync("build/results.json", JSON.stringify(out, null, 1));
console.log("build/results.json u shkrua");
process.exit(0);
