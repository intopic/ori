// CIP-MPT: peme Poseidon mbi F_p (BN254) me aritet 2^b (b = 1 binare, b = 3 oktale).
// Gjethja vendoset ne thellesine e pare ku shtegu i saj eshte unik; nenpema bosh ka hesh 0.
//   a(k)      = Poseidon(k_hi, k_lo)             shtegu; shifra i = (a >> (b*i)) & (2^b - 1)
//   H(gjethe) = Poseidon(a, v, 1)
//   H(nyje)   = Poseidon(H(femija_0), ..., H(femija_{2^b - 1}))
import { buildPoseidon } from "circomlibjs";

export const PATH_BITS = 248;
const MASK128 = (1n << 128n) - 1n;

export async function createHasher() {
  const p = await buildPoseidon();
  const counted = (xs) => { counted.count++; return p.F.toObject(p(xs)); };
  counted.count = 0;
  return counted;
}

export class CipTrie {
  constructor(hash, b = 1) {
    this.hash = hash;
    this.b = b;
    this.arity = 1 << b;
    this.maxDepth = Math.floor(PATH_BITS / b);
    this.rootNode = null;
    this.size = 0;
  }

  digit(a, i) {
    return Number((a >> BigInt(this.b * i)) & BigInt(this.arity - 1));
  }

  pathOf(key) {
    return this.hash([key >> 128n, key & MASK128]);
  }

  get root() {
    return this.rootNode ? this.rootNode.hash : 0n;
  }

  _leaf(a, value) {
    return { leaf: true, a, value, hash: this.hash([a, value, 1n]) };
  }

  _node(children) {
    return { leaf: false, children, hash: this.hash(children.map((c) => (c ? c.hash : 0n))) };
  }

  _with(children, i, child) {
    const c = children.slice();
    c[i] = child;
    return this._node(c);
  }

  // Shtyn dy gjethe me shtigje te ndryshme poshte derisa shifrat e tyre te ndahen.
  _split(x, y, depth) {
    if (depth >= this.maxDepth) throw new Error("thellesia maksimale u tejkalua");
    const dx = this.digit(x.a, depth), dy = this.digit(y.a, depth);
    const children = Array(this.arity).fill(null);
    if (dx !== dy) { children[dx] = x; children[dy] = y; }
    else children[dx] = this._split(x, y, depth + 1);
    return this._node(children);
  }

  _insert(node, leaf, depth) {
    if (!node) { this.size++; return leaf; }
    if (node.leaf) {
      if (node.a === leaf.a) return leaf; // perditesim i vleres
      this.size++;
      return this._split(node, leaf, depth);
    }
    const i = this.digit(leaf.a, depth);
    return this._with(node.children, i, this._insert(node.children[i], leaf, depth + 1));
  }

  insert(key, value) {
    this.rootNode = this._insert(this.rootNode, this._leaf(this.pathOf(key), value), 0);
  }

  // Deshmi anetaresie: per cdo nivel, heshet e te gjithe femijeve. null nese celesi mungon.
  prove(key) {
    const a = this.pathOf(key);
    const levels = [];
    let node = this.rootNode;
    while (node && !node.leaf) {
      levels.push(node.children.map((c) => (c ? c.hash : 0n)));
      node = node.children[this.digit(a, levels.length - 1)];
    }
    if (!node || node.a !== a) return null;
    return { key, value: node.value, levels, b: this.b };
  }

  // Kryen futjen/perditesimin dhe kthen hyrjen per qarkun CIPUpdate(D, b).
  // mode: "empty" (vend bosh), "update" (celesi ekziston), "push" (shtyn poshte nje gjethe tjeter).
  updateWithWitness(key, value, D) {
    const a = this.pathOf(key);
    const zero = Array(this.arity).fill(0n);
    const children = [];
    let node = this.rootNode;
    while (node && !node.leaf) {
      children.push(node.children.map((c) => (c ? c.hash : 0n)));
      node = node.children[this.digit(a, children.length - 1)];
    }
    const d = children.length;
    let mode = "empty", oldValue = 0n, otherPath = 0n, otherValue = 0n;
    if (node && node.a === a) {
      mode = "update";
      oldValue = node.value;
    } else if (node) {
      mode = "push";
      otherPath = node.a;
      otherValue = node.value;
      let i = d;
      while (this.digit(a, i) === this.digit(node.a, i)) { children.push(zero); i++; }
      const last = zero.slice();
      last[this.digit(node.a, i)] = node.hash;
      children.push(last);
    }
    const dNew = children.length;
    if (dNew > D) throw new Error(`kalimi kerkon ${dNew} nivele > D=${D}`);
    const oldRoot = this.root;
    this.insert(key, value);
    const flags = (len) => Array.from({ length: D }, (_, i) => (i < len ? "1" : "0"));
    return {
      mode,
      levels: dNew,
      input: {
        oldRoot: String(oldRoot),
        newRoot: String(this.root),
        keyHi: String(key >> 128n),
        keyLo: String(key & MASK128),
        newValue: String(value),
        oldValue: String(oldValue),
        otherPath: String(otherPath),
        otherValue: String(otherValue),
        isUpdate: mode === "update" ? "1" : "0",
        isPush: mode === "push" ? "1" : "0",
        children: children.concat(Array(D - dNew).fill(zero)).map((l) => l.map(String)),
        activeOld: flags(d),
        activeNew: flags(dNew),
      },
    };
  }

  // Pozicionet e nyjeve te brendshme ne shtegun e nje celesi (per provat ne grup).
  pathPositions(key) {
    const a = this.pathOf(key);
    const out = [];
    let node = this.rootNode, d = 0;
    while (node && !node.leaf) {
      out.push(`${d}:${a & ((1n << BigInt(this.b * d)) - 1n)}`);
      node = node.children[this.digit(a, d)];
      d++;
    }
    return out;
  }
}

export function verifyProof(hash, root, proof) {
  const mask = BigInt((1 << proof.b) - 1);
  const a = hash([proof.key >> 128n, proof.key & MASK128]);
  let cur = hash([a, proof.value, 1n]);
  for (let i = proof.levels.length - 1; i >= 0; i--) {
    const d = Number((a >> BigInt(proof.b * i)) & mask);
    if (proof.levels[i][d] !== cur) return false;
    cur = hash(proof.levels[i]);
  }
  return cur === root;
}

// Hyrja per qarkun me D nivele fikse.
export function circuitInput(root, proof, D) {
  const d = proof.levels.length;
  if (d > D) throw new Error(`deshmia ka thellesi ${d} > D=${D}`);
  const empty = Array(1 << proof.b).fill(0n);
  const levels = proof.levels.concat(Array(D - d).fill(empty));
  return {
    root: String(root),
    keyHi: String(proof.key >> 128n),
    keyLo: String(proof.key & MASK128),
    value: String(proof.value),
    children: levels.map((l) => l.map(String)),
    active: Array.from({ length: D }, (_, i) => (i < d ? "1" : "0")),
  };
}
