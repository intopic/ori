//! Provon dhe verifikon një qark të kompiluar, dhe kryqëzon rezultatin me snarkjs.
//!
//! `ori-prove <emri> [prova]`  p.sh. `ori-prove m_b1_D20 5`
//!
//! Lexon `circuits/<emri>.r1cs`, `circuits/<emri>_js/<emri>.wasm`, `build/<emri>.zkey` dhe
//! `build/<emri>_input.json`. Nëse ekzistojnë `build/<emri>_proof.json` dhe `_public.json`
//! (prova e snarkjs), i verifikon edhe ato. Shkruan `build/<emri>_rust_proof.json`,
//! `build/<emri>_rust_public.json` dhe një rresht JSON me kohët në dalje.

use ark_bn254::Fr;
use ark_ff::One;
use ori_prover::{proof_from_json, proof_to_json, public_from_json, public_to_json, Prover};
use serde_json::{json, Value};
use std::time::Instant;

fn read_json(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let name = args.next().ok_or("përdorimi: ori-prove <emri> [prova]")?;
    let runs: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(5);

    let t0 = Instant::now();
    let mut prover = Prover::load(
        format!("build/{name}.zkey"),
        format!("circuits/{name}_js/{name}.wasm"),
        format!("circuits/{name}.r1cs"),
    )?;
    let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let input = read_json(&format!("build/{name}_input.json"))?;
    let (mut wit_ms, mut prove_ms) = (Vec::new(), Vec::new());
    let mut last = None;
    for _ in 0..runs {
        let t = Instant::now();
        let witness = prover.witness(&input)?;
        wit_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        let proof = prover.prove(&witness)?;
        prove_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        last = Some((witness, proof));
    }
    let (witness, proof) = last.ok_or("asnjë provë")?;
    let public = prover.public_inputs(&witness).to_vec();

    let t = Instant::now();
    if !prover.verify(&public, &proof)? {
        return Err("prova e Rust u refuzua nga verifikuesi i Rust".into());
    }
    let verify_ms = t.elapsed().as_secs_f64() * 1000.0;

    // hyrje publike e ndryshuar duhet të refuzohet
    let mut forged = public.clone();
    forged[0] += Fr::one();
    if prover.verify(&forged, &proof)? {
        return Err("prova u pranua me hyrje publike të rreme".into());
    }

    // hyrje e falsifikuar e qarkut: dëshmitari nuk duhet të llogaritet
    let mut bad_input = input.clone();
    let field = if bad_input.get("root").is_some() {
        "root"
    } else {
        "newRoot"
    };
    bad_input[field] = json!("12345");
    if prover.witness(&bad_input).is_ok() {
        return Err("dëshmitari u llogarit për një rrënjë të rreme".into());
    }

    // prova e snarkjs, nëse ekziston, verifikohet nga Rust
    let snarkjs_checked = match (
        read_json(&format!("build/{name}_proof.json")),
        read_json(&format!("build/{name}_public.json")),
    ) {
        (Ok(p), Ok(s)) => {
            let ok = prover.verify(&public_from_json(&s)?, &proof_from_json(&p)?)?;
            if !ok {
                return Err("prova e snarkjs u refuzua nga verifikuesi i Rust".into());
            }
            true
        }
        _ => false,
    };

    let write = |path: String, v: &Value| std::fs::write(&path, v.to_string()).map_err(|e| format!("{path}: {e}"));
    write(format!("build/{name}_rust_proof.json"), &proof_to_json(&proof))?;
    write(format!("build/{name}_rust_public.json"), &public_to_json(&public))?;

    let mean = |xs: &[f64]| xs.iter().sum::<f64>() / xs.len() as f64;
    let min = |xs: &[f64]| xs.iter().cloned().fold(f64::INFINITY, f64::min);
    println!(
        "{}",
        json!({
            "emri": name,
            "kufizime": prover.num_constraints(),
            "ngarkimMs": load_ms.round(),
            "deshmitarMs": (mean(&wit_ms) * 10.0).round() / 10.0,
            "proveMinMs": (min(&prove_ms) * 10.0).round() / 10.0,
            "proveMesMs": (mean(&prove_ms) * 10.0).round() / 10.0,
            "verifyMs": (verify_ms * 10.0).round() / 10.0,
            "snarkjsVerifikuarNgaRust": snarkjs_checked,
            "fije": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        })
    );
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("gabim: {e}");
        std::process::exit(1);
    }
}
