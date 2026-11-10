// Mat metrikat e tabeles fillestare te studimit ne kete makine dhe shkruan build/results.json.
// Gjeneron edhe kontratat verifikuese dhe testet Foundry per matjen e gazit.
//   node js/claims.mjs [log2N]
import * as snarkjs from "snarkjs";
import { createHasher, CipTrie, circuitInput, batchInput } from "./trie.mjs";
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
// kind: m = anetaresi, u = perditesim, k<K> = grup me K perditesime
const VARIANTS = [
  { kind: "m", b: 1, D: 20 },  // shkalla e pohimit origjinal: 20 nivele
  { kind: "m", b: 1, D: 32 },
  { kind: "m", b: 3, D: 7 },   // 21 bit shteg, aritet 8
  { kind: "m", b: 3, D: 11 },
  { kind: "u", b: 1, D: 24 },
  { kind: "u", b: 3, D: 11 },
  { kind: "k4", b: 1, D: 24 },
  { kind: "k4", b: 3, D: 11 },
];
const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;

const ptau = await ensurePtau(16);
const hash = await createHasher();
const out = {
  runner: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), node: process.version },
  N,
  tree: {},
  circuits: [],
  gas: {},
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

// Nje kalim gjendjeje qe hyn ne D nivele (provon celesa te rinj derisa te gjeje nje te tille).
function nextUpdate(trie, D, i) {
  for (;;) {
    try { return trie.updateWithWitness(r(), BigInt(3 + i), D).input; } catch { /* shume thelle per kete D */ }
  }
}

const artifacts = {};
for (const { kind, b, D } of VARIANTS) {
  const name = `${kind}_b${b}_D${D}`;
  const wasm = `circuits/${name}_js/${name}.wasm`;
  const zkey = await ensureZkey(name, ptau);
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  const info = await snarkjs.r1cs.info(`circuits/${name}.r1cs`);
  const trie = tries[b];
  const K = kind.startsWith("k") ? Number(kind.slice(1)) : 1;
  const runs = K > 1 ? 3 : RUNS;

  const inputs = [];
  if (kind === "m") {
    for (const k of keys) {
      const p = trie.prove(k);
      if (p.levels.length <= D) inputs.push(circuitInput(trie.root, p, D));
      if (inputs.length === runs) break;
    }
  } else if (kind === "u") {
    inputs.push(trie.updateWithWitness(keys[1], 9n, D).input);
    while (inputs.length < runs) inputs.push(nextUpdate(trie, D, inputs.length));
  } else {
    while (inputs.length < runs) {
      const txs = [trie.updateWithWitness(keys[10 + inputs.length], 11n, D).input]; // nje perditesim + futje
      while (txs.length < K) txs.push(nextUpdate(trie, D, txs.length));
      inputs.push(batchInput(hash, txs));
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
    emri: name, lloji: kind === "m" ? "anetaresi" : kind === "u" ? "perditesim" : "grup", K, aritet: 1 << b, nivele: D,
    kufizime: info.nConstraints,
    publike: publicSignals.length,
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
  artifacts[name] = { zkey, proof, publicSignals, K };
}

// Kontratat verifikuese + testet Foundry me prova reale.
const require = createRequire(import.meta.url);
const tpl = readFileSync(path.join(path.dirname(require.resolve("snarkjs")), "..", "templates", "verifier_groth16.sol.ejs"), "utf8");
mkdirSync("contracts/src", { recursive: true });
mkdirSync("contracts/test", { recursive: true });

async function emitVerifier(name, contract, label) {
  const { zkey, proof, publicSignals, K } = artifacts[name];
  const sol = (await snarkjs.zKey.exportSolidityVerifier(zkey, { groth16: tpl })).replace("contract Groth16Verifier", `contract ${contract}`);
  writeFileSync(`contracts/src/${contract}.sol`, sol);
  const call = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, bb, c, pub] = JSON.parse(`[${call}]`);
  const lit = (xs) => `[uint256(${xs[0]}), ${xs.slice(1).join(", ")}]`;
  const n = pub.length;
  writeFileSync(`contracts/test/${contract}Gas.t.sol`, `// SPDX-License-Identifier: MIT
// SKEDAR I GJENERUAR nga js/claims.mjs - mos e ndryshoni me dore.
pragma solidity ^0.8.20;

import "../src/${contract}.sol";

contract ${contract}GasTest {
    event log_named_uint(string key, uint256 val);

    ${contract} internal v;

    function setUp() public {
        v = new ${contract}();
    }

    function _args() internal pure returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[${n}] memory p) {
        a = ${lit(a)};
        b = [${lit(bb[0])}, ${lit(bb[1])}];
        c = ${lit(c)};
        p = ${lit(pub)};
    }

    function testVerifyGas() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[${n}] memory p) = _args();
        uint256 g = gasleft();
        bool ok = v.verifyProof(a, b, c, p);
        uint256 used = g - gasleft();
        require(ok, "prova e vlefshme u refuzua");
        emit log_named_uint("${label}", used);
    }

    function testRejectsForgedPublicInput() public view {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[${n}] memory p) = _args();
        p[${n - 1}] += 1;
        require(!v.verifyProof(a, b, c, p), "prova e rreme u pranua");
    }
}
`);
  // gazi i te dhenave te transaksionit: 16 per bajt jozero, 4 per bajt zero, + 4 bajt selektor
  const hex = [a, bb.flat(), c, pub].flat().map((x) => BigInt(x).toString(16).padStart(64, "0")).join("");
  let calldataGas = 4 * 16;
  for (let i = 0; i < hex.length; i += 2) calldataGas += hex.slice(i, i + 2) === "00" ? 4 : 16;
  out.gas[label] = { emri: name, K, publike: n, calldataBajt: 4 + hex.length / 2, calldataGas };
  return { a, bb, c, pub, K, lit };
}
await emitVerifier("m_b1_D20", "MembershipVerifier", "verify_gas");
const batch = await emitVerifier("k4_b1_D24", "BatchVerifier", "batch_verify_gas");

// Kontrata e gjendjes OriState: teste me proven reale te grupit.
{
  const { a, bb, c, pub, K, lit } = batch;
  const args = "(uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[3] memory p) = _args();";
  writeFileSync("contracts/test/OriStateGas.t.sol", `// SPDX-License-Identifier: MIT
// SKEDAR I GJENERUAR nga js/claims.mjs - mos e ndryshoni me dore.
pragma solidity ^0.8.20;

import "../src/BatchVerifier.sol";
import "../src/OriState.sol";

contract Outsider {
    function trySubmit(OriState s, uint256 newRoot, uint256 txCommit, uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c)
        external
        returns (bool ok)
    {
        try s.submitBatch(newRoot, txCommit, a, b, c) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function accept(OriState s) external {
        s.acceptOperator();
    }
}

contract OriStateGasTest {
    event log_named_uint(string key, uint256 val);

    uint256 internal constant K = ${K};
    BatchVerifier internal v;
    OriState internal s;

    function _args() internal pure returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[3] memory p) {
        a = ${lit(a)};
        b = [${lit(bb[0])}, ${lit(bb[1])}];
        c = ${lit(c)};
        p = ${lit(pub)};
    }

    function setUp() public {
        v = new BatchVerifier();
        (, , , uint256[3] memory p) = _args();
        s = new OriState(IBatchVerifier(address(v)), p[0], K, address(this));
    }

    function _rejected(OriState target, uint256 newRoot, uint256 txCommit) internal returns (bool) {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, ) = _args();
        try target.submitBatch(newRoot, txCommit, a, b, c) {
            return false;
        } catch {
            return true;
        }
    }

    function testSubmitBatchGas() public {
        ${args}
        uint256 g = gasleft();
        s.submitBatch(p[1], p[2], a, b, c);
        uint256 used = g - gasleft();
        require(s.stateRoot() == p[1], "rrenja nuk u perditesua");
        require(s.batchCount() == 1, "numeruesi i grupeve");
        emit log_named_uint("submit_batch_gas", used);
    }

    function testReplayIsRejected() public {
        ${args}
        s.submitBatch(p[1], p[2], a, b, c);
        require(_rejected(s, p[1], p[2]), "ripersritja u pranua");
        require(s.stateRoot() == p[1] && s.batchCount() == 1, "gjendja ndryshoi nga ripersritja");
    }

    function testForgedNewRootIsRejected() public {
        (, , , uint256[3] memory p) = _args();
        require(_rejected(s, p[1] + 1, p[2]), "rrenja e rreme u pranua");
        require(s.stateRoot() == p[0] && s.batchCount() == 0, "gjendja ndryshoi");
    }

    function testForgedCommitIsRejected() public {
        (, , , uint256[3] memory p) = _args();
        require(_rejected(s, p[1], p[2] + 1), "angazhimi i rreme u pranua");
        require(s.stateRoot() == p[0], "gjendja ndryshoi");
    }

    function testWrongStartingRootIsRejected() public {
        (, , , uint256[3] memory p) = _args();
        OriState other = new OriState(IBatchVerifier(address(v)), p[0] + 1, K, address(this));
        require(_rejected(other, p[1], p[2]), "prova u pranua mbi nje rrenje tjeter");
    }

    function testOutOfFieldAliasesAreRejected() public {
        (, , , uint256[3] memory p) = _args();
        uint256 field = s.FIELD();
        require(_rejected(s, p[1] + field, p[2]), "alias i rrenjes jashte fushes u pranua");
        require(_rejected(s, p[1], p[2] + field), "alias i angazhimit jashte fushes u pranua");
        require(s.stateRoot() == p[0], "gjendja ndryshoi");
    }

    function testOnlyOperatorCanSubmit() public {
        ${args}
        Outsider o = new Outsider();
        require(!o.trySubmit(s, p[1], p[2], a, b, c), "nje i huaj dergoi grup");
        require(s.stateRoot() == p[0], "gjendja ndryshoi");
    }

    function testOperatorTransferIsTwoStep() public {
        ${args}
        Outsider o = new Outsider();
        s.transferOperator(address(o));
        require(s.operator() == address(this), "roli kaloi pa pranim");
        o.accept(s);
        require(s.operator() == address(o), "roli nuk kaloi");
        require(_rejected(s, p[1], p[2]), "operatori i vjeter dergoi grup");
        require(o.trySubmit(s, p[1], p[2], a, b, c), "operatori i ri nuk dergoi dot");
        require(s.stateRoot() == p[1], "rrenja nuk u perditesua");
    }
}
`);
  // te dhenat e thirrjes submitBatch: selektori + newRoot, txCommit dhe 8 fjale te proves
  const hex = [pub[1], pub[2], a, bb.flat(), c].flat().map((x) => BigInt(x).toString(16).padStart(64, "0")).join("");
  let calldataGas = 4 * 16;
  for (let i = 0; i < hex.length; i += 2) calldataGas += hex.slice(i, i + 2) === "00" ? 4 : 16;
  out.gas.submit_batch_gas = { emri: "k4_b1_D24", K, calldataBajt: 4 + hex.length / 2, calldataGas };
}

writeFileSync("build/results.json", JSON.stringify(out, null, 1));
console.log("build/results.json u shkrua");
process.exit(0);
