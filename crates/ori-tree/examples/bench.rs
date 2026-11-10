//! Matje e pemës: `cargo run --release -p ori-tree --example bench -- 14`
use ark_bn254::Fr;
use ori_tree::{Key, Tree};
use std::time::Instant;

fn main() {
    let e: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(14);
    let n = 1usize << e;
    let mut s = 2026u64;
    let mut next = move || {
        s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = s;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    let mut word = move || ((next() as u128) << 64) | next() as u128;
    let keys: Vec<Key> = (0..n)
        .map(|_| {
            let hi = word();
            let lo = word();
            Key::new(hi, lo)
        })
        .collect();

    println!("N = 2^{e} = {n} çelësa (Rust, një fije)");
    println!();
    println!("| Ariteti | Nivele mesatare | Nivele maksimale | Heshe për futje | Mikrosekonda për futje | Mikrosekonda për dëshmi |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for b in 1..=3 {
        let mut t = Tree::new(b);
        let t0 = Instant::now();
        for k in &keys {
            t.insert(*k, Fr::from(1u64));
        }
        let ins = t0.elapsed();
        let hashes = t.hash_count();
        let t1 = Instant::now();
        let (mut tot, mut max) = (0usize, 0usize);
        for k in &keys {
            let d = t.prove(*k).unwrap().levels.len();
            tot += d;
            max = max.max(d);
        }
        let prove = t1.elapsed();
        println!(
            "| {} | {:.3} | {} | {:.1} | {:.1} | {:.1} |",
            1 << b,
            tot as f64 / n as f64,
            max,
            hashes as f64 / n as f64,
            ins.as_micros() as f64 / n as f64,
            prove.as_micros() as f64 / n as f64
        );
    }
}
