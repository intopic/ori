// Nderton tabelen "pohimi fillestar kundrejt matjes" ne Markdown nga build/results.json,
// build/rust_results.jsonl dhe dalja e forge.
//   node js/summary.mjs [build/forge.txt]
import { readFileSync, existsSync } from "node:fs";

const res = JSON.parse(readFileSync("build/results.json", "utf8"));
const forgeFile = process.argv[2] ?? "build/forge.txt";
let gas = null;
let batchGas = null;
let submitGas = null;
if (existsSync(forgeFile)) {
  for (const line of readFileSync(forgeFile, "utf8").split("\n")) {
    const m = line.trim().match(/^(submit_batch_gas|batch_verify_gas|verify_gas):\s*(\d+)/);
    if (m && m[1] === "submit_batch_gas") submitGas = Number(m[2]);
    if (m && m[1] === "verify_gas") gas = Number(m[2]);
    if (m && m[1] === "batch_verify_gas") batchGas = Number(m[2]);
  }
}
const rust = {};
if (existsSync("build/rust_results.jsonl")) {
  for (const line of readFileSync("build/rust_results.jsonl", "utf8").split("\n")) {
    if (line.trim().startsWith("{")) {
      const r = JSON.parse(line);
      rust[r.emri] = r;
    }
  }
}
const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
const c = Object.fromEntries(res.circuits.map((x) => [x.emri, x]));
const m20 = c["m_b1_D20"];
const bin = res.tree.aritet2;
const label = (x) => `${x.lloji}${x.K > 1 ? ` K=${x.K}` : ""}`;

// Madhesia e deshmise per N = 10^6 nga formula e verifikuar: E[D] = log2 N + 1,333 nivele x 32 bajt.
const depth1e6 = Math.log2(1e6) + 1.333;
const r20 = rust["m_b1_D20"];
const rustS = r20 ? (r20.deshmitarMs + r20.proveMesMs) / 1000 : null;
const totalGas = gas === null ? null : gas + 21000 + res.gas.verify_gas.calldataGas;
const bg = res.gas.batch_verify_gas;
const batchTotal = batchGas === null || !bg ? null : batchGas + 21000 + bg.calldataGas;
const sg = res.gas.submit_batch_gas;
const submitTotal = submitGas === null || !sg ? null : submitGas + 21000 + sg.calldataGas;
const verdict = (claim, measured, tol = 0.25) =>
  measured <= claim * (1 + tol) ? "përputhet" : `nuk përputhet (${(measured / claim).toFixed(1)}x)`;

const L = [];
L.push("## Pohimet fillestare kundrejt matjes");
L.push("");
L.push(`Makina: ${res.runner.cpu}, ${res.runner.cores} bërthama, ${res.runner.ramGB} GB RAM, Node ${res.runner.node}. Groth16 mbi BN254, setup zhvillimi.`);
L.push("");
L.push("| Metrika | Sistemi konvencional (pohim) | CIP-MPT (pohim) | CIP-MPT (matur) | Përfundimi |");
L.push("| --- | --- | --- | --- | --- |");
L.push(`| Kufizime R1CS për dëshmi anëtarësie | 400 000 | 4 800 | ${fmt(m20.kufizime)} (20 nivele) | ${verdict(4800, m20.kufizime)} |`);
L.push(`| Koha e gjenerimit të provës | 12,4 s | 0,38 s | ${rustS === null ? "" : `${rustS.toFixed(3)} s në Rust; `}${m20.proveMesS.toFixed(2)} s në snarkjs | ${verdict(0.38, rustS ?? m20.proveMesS, 0)} |`);
L.push(`| Madhësia e dëshmisë së anëtarësisë | 3,8 KB | 0,64 KB | ${((depth1e6 * 32) / 1000).toFixed(2)} KB për N = 10^6 (formula); ${(bin.deshmiaBajtMes / 1000).toFixed(2)} KB e matur për N = ${fmt(res.N)} | ${verdict(640, depth1e6 * 32)} |`);
L.push(`| Kostoja e verifikimit në kontratë L1, një provë për transaksion | 240 000 gas | 38 000 gas | ${gas === null ? "nuk u mat" : `${fmt(gas)} gas ekzekutim; ${fmt(totalGas)} gas transaksioni i plotë`} | ${gas === null ? "–" : verdict(38000, gas, 0)} |`);
if (batchTotal !== null) {
  L.push(`| Kostoja në L1 për transaksion, me provë në grup (K = ${bg.K}) | – | 38 000 gas | ${fmt(batchTotal / bg.K)} gas për transaksion (${fmt(batchTotal)} gas për grupin, ${bg.publike} hyrje publike) | ${verdict(38000, batchTotal / bg.K, 0)} |`);
}
if (submitTotal !== null) {
  L.push(`| Kostoja në L1 për transaksion përmes kontratës së gjendjes OriState (K = ${sg.K}) | – | 38 000 gas | ${fmt(submitTotal / sg.K)} gas për transaksion (${fmt(submitTotal)} gas për grupin: verifikim, ruajtje e rrënjës, ngjarje) | ${verdict(38000, submitTotal / sg.K, 0)} |`);
}
L.push("");
L.push("Shënime:");
L.push("- Sistemi konvencional (pema Keccak) nuk është matur këtu. Një qark Keccak-256 në circom raportohet me rreth 150 848 kufizime (shifër e cituar nga keccak256-circom, jo e matur në këtë punë).");
L.push("- Prova Groth16 që shkon në zinxhir ka 128 bajt të kompresuar, pavarësisht nga pema; rreshti i madhësisë krahason dëshminë e papunuar Merkle.");
L.push("- Gazi i verifikimit Groth16 varet nga numri i hyrjeve publike, jo nga madhësia e qarkut.");
if (batchTotal !== null) {
  L.push(`- Gazi i grupit nuk varet nga K (hyrjet publike janë gjithmonë ${bg.publike}), ndaj kostoja për transaksion është ${fmt(batchTotal)} / K. Pohimi 38 000 gas arrihet për K ≥ ${Math.ceil(batchTotal / 38000)}. Kjo nuk përfshin publikimin e të dhënave të transaksioneve në L1, që një rollup real e paguan veçmas.`);
}
if (submitTotal !== null) {
  L.push(`- Me kontratën OriState, pohimi 38 000 gas arrihet për K ≥ ${Math.ceil(submitTotal / 38000)}. Kontrata e merr rrënjën e vjetër nga ruajtja, ndaj një provë nuk mund të ripërdoret.`);
}
L.push("");
L.push("### Të gjitha qarqet e matura (snarkjs)");
L.push("");
L.push("| Qarku | Ariteti | Nivele | Kufizime | Dëshmitari | Provë, minimumi | Provë, mesatarja | Verifikim |");
L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const x of res.circuits) {
  L.push(`| ${label(x)} | ${x.aritet} | ${x.nivele} | ${fmt(x.kufizime)} | ${x.deshmitarMs} ms | ${x.proveMinS.toFixed(2)} s | ${x.proveMesS.toFixed(2)} s | ${x.verifyMs} ms |`);
}
L.push("");
if (Object.keys(rust).length) {
  L.push("### Rust kundrejt snarkjs (dëshmitar + provë, mesatarja)");
  L.push("");
  L.push("| Qarku | Ariteti | Nivele | Kufizime | snarkjs | Rust: dëshmitar | Rust: provë | Rust: gjithsej | Rust për transaksion | Përshpejtimi |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const x of res.circuits) {
    const r = rust[x.emri];
    if (!r) continue;
    const tot = r.deshmitarMs + r.proveMesMs;
    L.push(`| ${label(x)} | ${x.aritet} | ${x.nivele} | ${fmt(x.kufizime)} | ${fmt(x.proveMesS * 1000)} ms | ${r.deshmitarMs} ms | ${r.proveMesMs} ms | ${tot.toFixed(1)} ms | ${(tot / x.K).toFixed(1)} ms | ${((x.proveMesS * 1000) / tot).toFixed(1)}x |`);
  }
  L.push("");
  L.push(`Rust përdor ${Object.values(rust)[0].fije} fije. Provat e Rust verifikohen nga snarkjs dhe provat e snarkjs nga Rust.`);
  L.push("");
}
L.push("### Pema");
L.push("");
L.push("| Ariteti | Nivele mesatare | Nivele maksimale | Dëshmia e papunuar (mesatare) |");
L.push("| --- | --- | --- | --- |");
for (const [k, t] of Object.entries(res.tree)) {
  L.push(`| ${k.replace("aritet", "")} | ${t.niveleMes} | ${t.niveleMax} | ${fmt(t.deshmiaBajtMes)} bajt |`);
}
console.log(L.join("\n"));
