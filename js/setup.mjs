// Setup Groth16 VETEM PER ZHVILLIM: powers of tau te gjeneruara lokalisht, pa ceremoni te besuar.
import * as snarkjs from "snarkjs";
import { existsSync, mkdirSync } from "node:fs";

export async function ensurePtau(power) {
  mkdirSync("build", { recursive: true });
  const final = `build/pot${power}_final.ptau`;
  if (!existsSync(final)) {
    const curve = await snarkjs.curves.getCurveFromName("bn128");
    await snarkjs.powersOfTau.newAccumulator(curve, power, `build/pot${power}_0.ptau`);
    await snarkjs.powersOfTau.contribute(`build/pot${power}_0.ptau`, `build/pot${power}_1.ptau`, "dev", "ori-dev-entropy");
    await snarkjs.powersOfTau.preparePhase2(`build/pot${power}_1.ptau`, final);
  }
  return final;
}

export async function ensureZkey(name, ptau) {
  const zkey = `build/${name}.zkey`;
  if (!existsSync(zkey)) await snarkjs.zKey.newZKey(`circuits/${name}.r1cs`, ptau, zkey);
  return zkey;
}
