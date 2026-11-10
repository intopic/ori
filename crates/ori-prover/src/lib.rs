//! Provues Groth16 (BN254) për qarqet circom të CIP-MPT.
//!
//! Lexon `.zkey` dhe `.r1cs` të prodhuara nga circom/snarkjs, llogarit dëshmitarin me modulin
//! WASM të qarkut dhe prodhon prova të pajtueshme me snarkjs (i njëjti reduktim QAP).

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_circom::index::NPIndex;
use ark_circom::{read_zkey, CircomConfig, CircomReduction};
use ark_ff::PrimeField;
use ark_groth16::{prepare_verifying_key, Groth16, PreparedVerifyingKey, Proof, ProvingKey};
use num_bigint::BigInt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::str::FromStr;

pub type Res<T> = Result<T, String>;

fn err<E: std::fmt::Debug>(what: &str) -> impl Fn(E) -> String + '_ {
    move |e| format!("{what}: {e:?}")
}

/// Një qark i ngarkuar: çelësi i provës, matricat R1CS dhe llogaritësi i dëshmitarit.
pub struct Prover {
    pk: ProvingKey<Bn254>,
    matrices: NPIndex<Fr>,
    /// Matricat A, B, C në formën që pret provuesi (përgatiten një herë).
    abc: Vec<Vec<Vec<(Fr, usize)>>>,
    cfg: CircomConfig<Fr>,
    pvk: PreparedVerifyingKey<Bn254>,
}

impl Prover {
    /// Ngarkon qarkun nga `.zkey`, moduli WASM i dëshmitarit dhe `.r1cs`.
    pub fn load(zkey: impl AsRef<Path>, wasm: impl AsRef<Path>, r1cs: impl AsRef<Path>) -> Res<Self> {
        let mut reader = BufReader::new(File::open(zkey).map_err(err("hapja e zkey"))?);
        let (pk, matrices) = read_zkey(&mut reader).map_err(err("leximi i zkey"))?;
        let cfg = CircomConfig::<Fr>::new(wasm, r1cs).map_err(err("ngarkimi i qarkut"))?;
        let pvk = prepare_verifying_key(&pk.vk);
        let abc = vec![matrices.a.clone(), matrices.b.clone(), matrices.c.clone()];
        Ok(Self {
            pk,
            matrices,
            abc,
            cfg,
            pvk,
        })
    }

    pub fn num_constraints(&self) -> usize {
        self.matrices.num_constraints
    }

    /// Numri i hyrjeve publike (pa konstanten 1).
    pub fn num_public(&self) -> usize {
        self.matrices.num_instance_variables - 1
    }

    /// Llogarit dëshmitarin e plotë nga hyrja JSON e qarkut. Dështon nëse një kufizim nuk plotësohet.
    pub fn witness(&mut self, input: &Value) -> Res<Vec<Fr>> {
        let inputs = flatten_input(input)?;
        self.cfg
            .wtns
            .calculate_witness_element::<Fr, _>(&mut self.cfg.store, inputs, false)
            .map_err(err("llogaritja e dëshmitarit"))
    }

    /// Hyrjet publike brenda një dëshmitari.
    pub fn public_inputs<'a>(&self, witness: &'a [Fr]) -> &'a [Fr] {
        &witness[1..self.matrices.num_instance_variables]
    }

    /// Prodhon provën Groth16 për një dëshmitar.
    pub fn prove(&self, witness: &[Fr]) -> Res<Proof<Bn254>> {
        let r = random_fr()?;
        let s = random_fr()?;
        Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
            &self.pk,
            r,
            s,
            &self.abc,
            self.matrices.num_instance_variables,
            self.matrices.num_constraints,
            witness,
        )
        .map_err(err("prova"))
    }

    /// Verifikon një provë kundrejt hyrjeve publike.
    pub fn verify(&self, public: &[Fr], proof: &Proof<Bn254>) -> Res<bool> {
        Groth16::<Bn254>::verify_proof(&self.pvk, proof, public).map_err(err("verifikimi"))
    }
}

/// Skalar i rastësishëm nga burimi i sistemit operativ (për fshehjen e provës).
fn random_fr() -> Res<Fr> {
    let mut buf = [0u8; 64];
    getrandom::getrandom(&mut buf).map_err(err("rastësia e sistemit"))?;
    Ok(Fr::from_le_bytes_mod_order(&buf))
}

fn flatten_value(v: &Value, out: &mut Vec<BigInt>) -> Res<()> {
    match v {
        Value::String(s) => out.push(BigInt::from_str(s).map_err(err("numër i pavlefshëm"))?),
        Value::Number(n) => out.push(BigInt::from_str(&n.to_string()).map_err(err("numër i pavlefshëm"))?),
        Value::Array(items) => {
            for item in items {
                flatten_value(item, out)?;
            }
        }
        other => return Err(format!("vlerë hyrjeje e pambështetur: {other}")),
    }
    Ok(())
}

/// Kthen hyrjen JSON (vlera, vargje ose vargje të ndërthurura) në formën që pret circom.
pub fn flatten_input(input: &Value) -> Res<HashMap<String, Vec<BigInt>>> {
    let obj = input.as_object().ok_or("hyrja duhet të jetë objekt JSON")?;
    let mut out = HashMap::new();
    for (name, value) in obj {
        let mut flat = Vec::new();
        flatten_value(value, &mut flat)?;
        out.insert(name.clone(), flat);
    }
    Ok(out)
}

fn fq_dec(x: &Fq) -> String {
    x.into_bigint().to_string()
}

fn fq_from(v: &Value) -> Res<Fq> {
    Fq::from_str(v.as_str().ok_or("pritej tekst")?).map_err(|_| "koordinatë e pavlefshme".to_string())
}

/// Prova në formatin JSON të snarkjs.
pub fn proof_to_json(proof: &Proof<Bn254>) -> Value {
    json!({
        "pi_a": [fq_dec(&proof.a.x), fq_dec(&proof.a.y), "1"],
        "pi_b": [
            [fq_dec(&proof.b.x.c0), fq_dec(&proof.b.x.c1)],
            [fq_dec(&proof.b.y.c0), fq_dec(&proof.b.y.c1)],
            ["1", "0"]
        ],
        "pi_c": [fq_dec(&proof.c.x), fq_dec(&proof.c.y), "1"],
        "protocol": "groth16",
        "curve": "bn128"
    })
}

/// Lexon një provë në formatin JSON të snarkjs. Pikat kontrollohen që janë në lakore.
pub fn proof_from_json(v: &Value) -> Res<Proof<Bn254>> {
    let g1 = |p: &Value| -> Res<G1Affine> {
        let (x, y) = (fq_from(&p[0])?, fq_from(&p[1])?);
        let point = G1Affine::new_unchecked(x, y);
        if !point.is_on_curve() || !point.is_in_correct_subgroup_assuming_on_curve() {
            return Err("pikë G1 e pavlefshme".into());
        }
        Ok(point)
    };
    let b = &v["pi_b"];
    let x = Fq2::new(fq_from(&b[0][0])?, fq_from(&b[0][1])?);
    let y = Fq2::new(fq_from(&b[1][0])?, fq_from(&b[1][1])?);
    let g2 = G2Affine::new_unchecked(x, y);
    if !g2.is_on_curve() || !g2.is_in_correct_subgroup_assuming_on_curve() {
        return Err("pikë G2 e pavlefshme".into());
    }
    Ok(Proof {
        a: g1(&v["pi_a"])?,
        b: g2,
        c: g1(&v["pi_c"])?,
    })
}

/// Hyrjet publike si vargje dhjetore (formati i snarkjs).
pub fn public_to_json(public: &[Fr]) -> Value {
    json!(public.iter().map(|x| x.into_bigint().to_string()).collect::<Vec<_>>())
}

/// Lexon hyrjet publike nga formati i snarkjs.
pub fn public_from_json(v: &Value) -> Res<Vec<Fr>> {
    v.as_array()
        .ok_or("pritej varg")?
        .iter()
        .map(|x| Fr::from_str(x.as_str().ok_or("pritej tekst")?).map_err(|_| "hyrje publike e pavlefshme".to_string()))
        .collect()
}
