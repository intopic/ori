use ark_bn254::Fr;
use ark_ff::One;
use ori_tree::{batch_input, fr_to_dec, membership_input, verify_proof, Hasher, Key, Mode, Tree};
use serde_json::Value;
use std::str::FromStr;

/// Gjenerues i thjeshtë deterministik (splitmix64) për çelësa testimi.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn word(&mut self) -> u128 {
        ((self.next() as u128) << 64) | self.next() as u128
    }

    fn key(&mut self) -> Key {
        let hi = self.word();
        let lo = self.word();
        Key::new(hi, lo)
    }
}

#[test]
fn poseidon_matches_circomlib_vector() {
    let mut h = Hasher::new();
    let expected =
        Fr::from_str("7853200120776062878684798364095072458815029376092732009249414926327459813530").unwrap();
    assert_eq!(h.hash(&[Fr::from(1u64), Fr::from(2u64)]), expected);
    // thirrja e dytë me të njëjtin hasher duhet të japë të njëjtin rezultat
    assert_eq!(h.hash(&[Fr::from(1u64), Fr::from(2u64)]), expected);
}

#[test]
fn root_is_order_independent_and_proofs_verify() {
    for b in 1..=3 {
        let mut rng = Rng(7);
        let items: Vec<(Key, Fr)> = (0..300u64).map(|i| (rng.key(), Fr::from(i + 1))).collect();
        let mut t1 = Tree::new(b);
        let mut t2 = Tree::new(b);
        for (k, v) in &items {
            t1.insert(*k, *v);
        }
        for (k, v) in items.iter().rev() {
            t2.insert(*k, *v);
        }
        assert_eq!(t1.root(), t2.root(), "rrënja varet nga radha (b={b})");
        assert_eq!(t1.len(), 300);

        let mut h = Hasher::new();
        let root = t1.root();
        for (k, v) in &items {
            let mut p = t1.prove(*k).expect("çelësi duhet të ekzistojë");
            assert_eq!(p.value, *v);
            assert!(verify_proof(&mut h, root, &p));
            p.value += Fr::one();
            assert!(!verify_proof(&mut h, root, &p), "vlera e ndryshuar u pranua");
        }
        assert!(t1.prove(rng.key()).is_none());

        // përditësimi ndryshon rrënjën dhe ruan madhësinë
        t1.insert(items[0].0, Fr::from(123u64));
        assert_ne!(t1.root(), root);
        assert_eq!(t1.len(), 300);
        let p = t1.prove(items[0].0).unwrap();
        assert!(verify_proof(&mut h, t1.root(), &p));
    }
}

#[test]
fn update_witness_covers_all_modes_and_chains_roots() {
    for b in 1..=3 {
        let mut rng = Rng(100 + b as u64);
        let mut t = Tree::new(b);
        let keys: Vec<Key> = (0..256).map(|_| rng.key()).collect();
        for k in &keys {
            t.insert(*k, Fr::from(5u64));
        }
        let max = t.max_depth();
        let (mut empty, mut push) = (0, 0);
        let mut prev = t.root();
        let w = t.update_with_witness(keys[3], Fr::from(77u64), max).unwrap();
        assert_eq!(w.mode, Mode::Update);
        assert_eq!(w.old_root, prev);
        assert_eq!(w.old_value, Fr::from(5u64));
        prev = w.new_root;
        for i in 0..400u64 {
            let w = t.update_with_witness(rng.key(), Fr::from(i + 1), max).unwrap();
            assert_eq!(w.old_root, prev, "zinxhiri i rrënjëve u këput");
            assert_eq!(w.new_root, t.root());
            prev = w.new_root;
            match w.mode {
                Mode::Empty => {
                    empty += 1;
                    assert_eq!(w.children.len(), w.old_levels);
                }
                Mode::Push => {
                    push += 1;
                    assert!(w.children.len() > w.old_levels);
                }
                Mode::Update => unreachable!("çelës i ri nuk mund të jetë përditësim"),
            }
        }
        assert!(push > 0, "b={b}: asnjë futje me shtyrje");
        assert!(empty > 0, "b={b}: asnjë futje në vend bosh");

        // pemë bosh: futja e parë
        let mut fresh = Tree::new(b);
        let w0 = fresh.update_with_witness(rng.key(), Fr::from(9u64), 4).unwrap();
        assert_eq!(w0.mode, Mode::Empty);
        assert!(w0.children.is_empty());

        // kufiri i niveleve respektohet pa ndryshuar pemën
        let before = t.root();
        assert!(t.update_with_witness(rng.key(), Fr::one(), 1).is_err());
        assert_eq!(t.root(), before);
    }
}

/// Krahasim bit-për-bit me implementimin JavaScript. Skedari gjenerohet nga `node js/vectors.mjs`
/// dhe jepet me variablin `ORI_VECTORS`; pa të, testi kapërcehet.
#[test]
fn matches_javascript_reference() {
    let Ok(path) = std::env::var("ORI_VECTORS") else {
        eprintln!("ORI_VECTORS mungon: krahasimi me JS u kapërcye");
        return;
    };
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let key = |v: &Value| {
        Key::new(
            v["hi"].as_str().unwrap().parse().unwrap(),
            v["lo"].as_str().unwrap().parse().unwrap(),
        )
    };
    let fr = |v: &Value| Fr::from_str(v.as_str().unwrap()).unwrap();
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let b = case["b"].as_u64().unwrap() as usize;
        let levels = case["levels"].as_u64().unwrap() as usize;
        let mut t = Tree::new(b);
        for item in case["items"].as_array().unwrap() {
            t.insert(key(&item["key"]), fr(&item["value"]));
        }
        assert_eq!(
            fr_to_dec(&t.root()),
            case["root"].as_str().unwrap(),
            "rrënja ndryshon nga JS (b={b})"
        );
        for m in case["membership"].as_array().unwrap() {
            let p = t.prove(key(&m["key"])).unwrap();
            let input = membership_input(t.root(), &p, levels).unwrap();
            assert_eq!(input, m["input"], "hyrja e anëtarësisë ndryshon nga JS (b={b})");
        }
        let mut first = Vec::new();
        for u in case["updates"].as_array().unwrap() {
            let w = t.update_with_witness(key(&u["key"]), fr(&u["value"]), levels).unwrap();
            let mode = match w.mode {
                Mode::Empty => "empty",
                Mode::Update => "update",
                Mode::Push => "push",
            };
            assert_eq!(mode, u["mode"].as_str().unwrap());
            assert_eq!(
                w.circuit_input(levels),
                u["input"],
                "hyrja e përditësimit ndryshon nga JS (b={b})"
            );
            if first.len() < 4 {
                first.push(w);
            }
        }
        let batch = batch_input(&mut Hasher::new(), &first, levels).unwrap();
        assert_eq!(batch, case["batch"], "hyrja e grupit ndryshon nga JS (b={b})");
        assert!(batch_input(&mut Hasher::new(), &first[..1], levels).is_err());
        assert!(batch_input(&mut Hasher::new(), &[first[1].clone(), first[0].clone()], levels).is_err());
        assert_eq!(fr_to_dec(&t.root()), case["finalRoot"].as_str().unwrap());
    }
}
