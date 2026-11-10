//! CIP-MPT: pemë Poseidon mbi fushën skalare të BN254, me aritet 2^b (b = 1, 2, 3).
//!
//! - shtegu:  `a(k) = Poseidon(k_hi, k_lo)`; shifra `i` = bitët `[b*i, b*i + b)` të `a`
//! - gjethja: `Poseidon(a, v, 1)`
//! - nyja:    `Poseidon(fëmijët)`; nënpema bosh ka hesh 0
//!
//! Gjethja vendoset në thellësinë e parë ku shtegu i saj është unik, prandaj rrënja varet
//! vetëm nga bashkësia e çifteve (çelës, vlerë). Sjellja është identike me `js/trie.mjs`.

use ark_bn254::Fr;
use ark_ff::{One, PrimeField, Zero};
use light_poseidon::{Poseidon, PoseidonHasher};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Numri i bitëve të shtegut që përdoren për pozicionim.
pub const PATH_BITS: usize = 248;

/// Poseidon me parametrat e circom, me numërim të thirrjeve.
pub struct Hasher {
    cache: HashMap<usize, Poseidon<Fr>>,
    pub count: u64,
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

impl Hasher {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
            count: 0,
        }
    }

    pub fn hash(&mut self, inputs: &[Fr]) -> Fr {
        self.count += 1;
        let n = inputs.len();
        let poseidon = self
            .cache
            .entry(n)
            .or_insert_with(|| Poseidon::<Fr>::new_circom(n).expect("numër hyrjesh i pambështetur"));
        poseidon.hash(inputs).expect("Poseidon dështoi")
    }
}

/// Çelës 256-bitësh, i ndarë në dy gjysma 128-bitëshe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub hi: u128,
    pub lo: u128,
}

impl Key {
    pub fn new(hi: u128, lo: u128) -> Self {
        Self { hi, lo }
    }
}

/// Shifra `i` (me `b` bit) e një shtegu.
pub fn digit(path: &Fr, b: usize, i: usize) -> usize {
    let limbs = path.into_bigint().0;
    let mut d = 0usize;
    for m in 0..b {
        let pos = b * i + m;
        let bit = (limbs[pos / 64] >> (pos % 64)) & 1;
        d |= (bit as usize) << m;
    }
    d
}

#[derive(Clone, Debug)]
enum Node {
    Leaf { path: Fr, value: Fr, hash: Fr },
    Inner { children: Vec<Option<Box<Node>>>, hash: Fr },
}

impl Node {
    fn hash(&self) -> Fr {
        match self {
            Node::Leaf { hash, .. } | Node::Inner { hash, .. } => *hash,
        }
    }
}

fn child_hash(c: &Option<Box<Node>>) -> Fr {
    c.as_ref().map(|n| n.hash()).unwrap_or_else(Fr::zero)
}

/// Dëshmi anëtarësie: për çdo nivel, heshet e të gjithë fëmijëve të nyjes në shteg.
#[derive(Clone, Debug, PartialEq)]
pub struct Proof {
    pub key: Key,
    pub value: Fr,
    pub levels: Vec<Vec<Fr>>,
    pub b: usize,
}

/// Mënyra e një kalimi gjendjeje.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Futje në një vend bosh.
    Empty,
    /// Çelësi ekziston; ndryshon vlera.
    Update,
    /// Futja shtyn poshtë një gjethe ekzistuese.
    Push,
}

/// Dëshmitari i një kalimi `old_root -> new_root` për qarkun `CIPUpdate`.
#[derive(Clone, Debug)]
pub struct UpdateWitness {
    pub mode: Mode,
    pub key: Key,
    pub new_value: Fr,
    pub old_root: Fr,
    pub new_root: Fr,
    pub old_value: Fr,
    pub other_path: Fr,
    pub other_value: Fr,
    /// Fëmijët për nivelet e pemës së vjetër, pastaj për nivelet e zgjatimit.
    pub children: Vec<Vec<Fr>>,
    /// Numri i niveleve në pemën e vjetër.
    pub old_levels: usize,
    /// Ariteti është 2^b.
    pub b: usize,
}

pub struct Tree {
    hasher: Hasher,
    b: usize,
    root: Option<Box<Node>>,
    size: usize,
}

impl Tree {
    /// Pemë bosh me aritet `2^b`.
    pub fn new(b: usize) -> Self {
        assert!((1..=3).contains(&b), "b duhet të jetë 1, 2 ose 3");
        Self {
            hasher: Hasher::new(),
            b,
            root: None,
            size: 0,
        }
    }

    pub fn arity(&self) -> usize {
        1 << self.b
    }

    pub fn len(&self) -> usize {
        self.size
    }

    pub fn is_empty(&self) -> bool {
        self.size == 0
    }

    pub fn max_depth(&self) -> usize {
        PATH_BITS / self.b
    }

    /// Numri i thirrjeve Poseidon të bëra deri tani.
    pub fn hash_count(&self) -> u64 {
        self.hasher.count
    }

    pub fn path_of(&mut self, key: Key) -> Fr {
        self.hasher.hash(&[Fr::from(key.hi), Fr::from(key.lo)])
    }

    pub fn root(&self) -> Fr {
        child_hash(&self.root)
    }

    fn leaf(&mut self, path: Fr, value: Fr) -> Box<Node> {
        let hash = self.hasher.hash(&[path, value, Fr::one()]);
        Box::new(Node::Leaf { path, value, hash })
    }

    fn inner(&mut self, children: Vec<Option<Box<Node>>>) -> Box<Node> {
        let hashes: Vec<Fr> = children.iter().map(child_hash).collect();
        let hash = self.hasher.hash(&hashes);
        Box::new(Node::Inner { children, hash })
    }

    fn empty_children(&self) -> Vec<Option<Box<Node>>> {
        (0..self.arity()).map(|_| None).collect()
    }

    /// Shtyn dy gjethe me shtigje të ndryshme poshtë derisa shifrat e tyre të ndahen.
    fn split(&mut self, x: Box<Node>, y: Box<Node>, depth: usize) -> Box<Node> {
        assert!(depth < self.max_depth(), "thellësia maksimale u tejkalua");
        let (px, py) = match (&*x, &*y) {
            (Node::Leaf { path: px, .. }, Node::Leaf { path: py, .. }) => (*px, *py),
            _ => unreachable!("split merr vetëm gjethe"),
        };
        let dx = digit(&px, self.b, depth);
        let dy = digit(&py, self.b, depth);
        let mut children = self.empty_children();
        if dx != dy {
            children[dx] = Some(x);
            children[dy] = Some(y);
        } else {
            children[dx] = Some(self.split(x, y, depth + 1));
        }
        self.inner(children)
    }

    fn insert_node(&mut self, node: Option<Box<Node>>, leaf: Box<Node>, leaf_path: Fr, depth: usize) -> Box<Node> {
        let Some(node) = node else {
            self.size += 1;
            return leaf;
        };
        match *node {
            Node::Inner { mut children, .. } => {
                let i = digit(&leaf_path, self.b, depth);
                let child = children[i].take();
                children[i] = Some(self.insert_node(child, leaf, leaf_path, depth + 1));
                self.inner(children)
            }
            Node::Leaf { path, value, hash } => {
                if path == leaf_path {
                    leaf // përditësim i vlerës
                } else {
                    self.size += 1;
                    self.split(Box::new(Node::Leaf { path, value, hash }), leaf, depth)
                }
            }
        }
    }

    /// Fut ose përditëson një çift (çelës, vlerë).
    pub fn insert(&mut self, key: Key, value: Fr) {
        let path = self.path_of(key);
        let leaf = self.leaf(path, value);
        let root = self.root.take();
        self.root = Some(self.insert_node(root, leaf, path, 0));
    }

    /// Dëshmi anëtarësie, ose `None` nëse çelësi mungon.
    pub fn prove(&mut self, key: Key) -> Option<Proof> {
        let path = self.path_of(key);
        let mut levels = Vec::new();
        let mut node = self.root.as_deref();
        loop {
            match node {
                Some(Node::Inner { children, .. }) => {
                    levels.push(children.iter().map(child_hash).collect::<Vec<Fr>>());
                    node = children[digit(&path, self.b, levels.len() - 1)].as_deref();
                }
                Some(Node::Leaf { path: p, value, .. }) if *p == path => {
                    return Some(Proof {
                        key,
                        value: *value,
                        levels,
                        b: self.b,
                    });
                }
                _ => return None,
            }
        }
    }

    /// Kryen futjen ose përditësimin dhe kthen dëshmitarin për qarkun `CIPUpdate(max_levels, b)`.
    /// Kthen gabim (pa ndryshuar pemën) nëse kalimi kërkon më shumë se `max_levels` nivele.
    pub fn update_with_witness(&mut self, key: Key, value: Fr, max_levels: usize) -> Result<UpdateWitness, String> {
        let path = self.path_of(key);
        let zero = vec![Fr::zero(); self.arity()];
        let mut children: Vec<Vec<Fr>> = Vec::new();
        let mut node = self.root.as_deref();
        while let Some(Node::Inner { children: cs, .. }) = node {
            children.push(cs.iter().map(child_hash).collect());
            node = cs[digit(&path, self.b, children.len() - 1)].as_deref();
        }
        let old_levels = children.len();
        let mut mode = Mode::Empty;
        let (mut old_value, mut other_path, mut other_value) = (Fr::zero(), Fr::zero(), Fr::zero());
        if let Some(Node::Leaf {
            path: p,
            value: v,
            hash,
        }) = node
        {
            if *p == path {
                mode = Mode::Update;
                old_value = *v;
            } else {
                mode = Mode::Push;
                other_path = *p;
                other_value = *v;
                let mut i = old_levels;
                while digit(&path, self.b, i) == digit(p, self.b, i) {
                    children.push(zero.clone());
                    i += 1;
                }
                let mut last = zero.clone();
                last[digit(p, self.b, i)] = *hash;
                children.push(last);
            }
        }
        if children.len() > max_levels {
            return Err(format!("kalimi kërkon {} nivele > {}", children.len(), max_levels));
        }
        let old_root = self.root();
        self.insert(key, value);
        Ok(UpdateWitness {
            mode,
            key,
            new_value: value,
            old_root,
            new_root: self.root(),
            old_value,
            other_path,
            other_value,
            children,
            old_levels,
            b: self.b,
        })
    }
}

/// Verifikon një dëshmi anëtarësie kundrejt një rrënje.
pub fn verify_proof(hasher: &mut Hasher, root: Fr, proof: &Proof) -> bool {
    let path = hasher.hash(&[Fr::from(proof.key.hi), Fr::from(proof.key.lo)]);
    let mut cur = hasher.hash(&[path, proof.value, Fr::one()]);
    for (i, level) in proof.levels.iter().enumerate().rev() {
        if level.len() != 1 << proof.b || level[digit(&path, proof.b, i)] != cur {
            return false;
        }
        cur = hasher.hash(level);
    }
    cur == root
}

/// Elementi i fushës si numër dhjetor (formati i hyrjeve të circom/snarkjs).
pub fn fr_to_dec(x: &Fr) -> String {
    x.into_bigint().to_string()
}

fn levels_json(levels: &[Vec<Fr>], arity: usize, total: usize) -> Value {
    let mut out: Vec<Vec<String>> = levels.iter().map(|l| l.iter().map(fr_to_dec).collect()).collect();
    out.resize(total, vec!["0".to_string(); arity]);
    json!(out)
}

fn flags(active: usize, total: usize) -> Vec<&'static str> {
    (0..total).map(|i| if i < active { "1" } else { "0" }).collect()
}

/// Hyrja për qarkun `CIPMembership(max_levels, b)`.
pub fn membership_input(root: Fr, proof: &Proof, max_levels: usize) -> Result<Value, String> {
    let d = proof.levels.len();
    if d > max_levels {
        return Err(format!("dëshmia ka {} nivele > {}", d, max_levels));
    }
    Ok(json!({
        "root": fr_to_dec(&root),
        "keyHi": proof.key.hi.to_string(),
        "keyLo": proof.key.lo.to_string(),
        "value": fr_to_dec(&proof.value),
        "children": levels_json(&proof.levels, 1 << proof.b, max_levels),
        "active": flags(d, max_levels),
    }))
}

impl UpdateWitness {
    /// Hyrja për qarkun `CIPUpdate(max_levels, b)`.
    pub fn circuit_input(&self, max_levels: usize) -> Value {
        let arity = 1 << self.b;
        json!({
            "oldRoot": fr_to_dec(&self.old_root),
            "newRoot": fr_to_dec(&self.new_root),
            "keyHi": self.key.hi.to_string(),
            "keyLo": self.key.lo.to_string(),
            "newValue": fr_to_dec(&self.new_value),
            "oldValue": fr_to_dec(&self.old_value),
            "otherPath": fr_to_dec(&self.other_path),
            "otherValue": fr_to_dec(&self.other_value),
            "isUpdate": if self.mode == Mode::Update { "1" } else { "0" },
            "isPush": if self.mode == Mode::Push { "1" } else { "0" },
            "children": levels_json(&self.children, arity, max_levels),
            "activeOld": flags(self.old_levels, max_levels),
            "activeNew": flags(self.children.len(), max_levels),
        })
    }
}

/// Hyrja për qarkun `CIPBatch(K, max_levels, b)` nga K kalime të njëpasnjëshme (K >= 2).
///
/// `txCommit`: `acc_0 = 0`, `acc_{i+1} = Poseidon(acc_i, keyHi_i, keyLo_i, newValue_i)`.
pub fn batch_input(hasher: &mut Hasher, witnesses: &[UpdateWitness], max_levels: usize) -> Result<Value, String> {
    if witnesses.len() < 2 {
        return Err("grupi kërkon të paktën 2 kalime".into());
    }
    let mut acc = Fr::zero();
    for (i, w) in witnesses.iter().enumerate() {
        if i > 0 && w.old_root != witnesses[i - 1].new_root {
            return Err("kalimet nuk janë të zinxhiruara".into());
        }
        acc = hasher.hash(&[acc, Fr::from(w.key.hi), Fr::from(w.key.lo), w.new_value]);
    }
    let inputs: Vec<Value> = witnesses.iter().map(|w| w.circuit_input(max_levels)).collect();
    let col = |field: &str| -> Value { json!(inputs.iter().map(|x| x[field].clone()).collect::<Vec<Value>>()) };
    let last = witnesses.len() - 1;
    Ok(json!({
        "oldRoot": fr_to_dec(&witnesses[0].old_root),
        "newRoot": fr_to_dec(&witnesses[last].new_root),
        "txCommit": fr_to_dec(&acc),
        "midRoots": witnesses[..last].iter().map(|w| fr_to_dec(&w.new_root)).collect::<Vec<String>>(),
        "keyHi": col("keyHi"),
        "keyLo": col("keyLo"),
        "newValue": col("newValue"),
        "oldValue": col("oldValue"),
        "otherPath": col("otherPath"),
        "otherValue": col("otherValue"),
        "isUpdate": col("isUpdate"),
        "isPush": col("isPush"),
        "children": col("children"),
        "activeOld": col("activeOld"),
        "activeNew": col("activeNew"),
    }))
}
