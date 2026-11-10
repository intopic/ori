// Gjeneron vektore krahasimi per implementimin ne Rust: node js/vectors.mjs > build/vectors.json
import { createHasher, CipTrie, circuitInput } from "./trie.mjs";
import { rng } from "./rng.mjs";

const LEVELS = { 1: 40, 2: 24, 3: 16 };
const MASK128 = (1n << 128n) - 1n;
const keyJson = (k) => ({ hi: String(k >> 128n), lo: String(k & MASK128) });

const hash = await createHasher();
const cases = [];
for (const b of [1, 2, 3]) {
  const D = LEVELS[b];
  const r = rng(40 + b);
  const trie = new CipTrie(hash, b);
  const items = Array.from({ length: 200 }, (_, i) => [r(), BigInt(i + 1)]);
  for (const [k, v] of items) trie.insert(k, v);
  const root = trie.root;
  const membership = [0, 17, 99, 150, 199].map((i) => ({
    key: keyJson(items[i][0]),
    input: circuitInput(root, trie.prove(items[i][0]), D),
  }));
  const todo = [
    [items[5][0], 1000n],
    ...Array.from({ length: 40 }, (_, i) => [r(), BigInt(2000 + i)]),
    [items[60][0], 3000n],
  ];
  const updates = [];
  for (const [k, v] of todo) {
    const w = trie.updateWithWitness(k, v, D);
    updates.push({ key: keyJson(k), value: String(v), mode: w.mode, input: w.input });
  }
  cases.push({
    b,
    levels: D,
    items: items.map(([k, v]) => ({ key: keyJson(k), value: String(v) })),
    root: String(root),
    membership,
    updates,
    finalRoot: String(trie.root),
  });
}
console.log(JSON.stringify({ cases }));
process.exit(0);
