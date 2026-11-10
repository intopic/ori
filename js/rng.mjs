// Gjenerues deterministik (xorshift64*) per celesa 256-bitesh te riprodhueshem.
export function rng(seed) {
  let s = BigInt(seed) | 1n;
  const M = (1n << 64n) - 1n;
  const next = () => {
    s ^= s >> 12n; s ^= (s << 25n) & M; s ^= s >> 27n;
    return (s * 0x2545F4914F6CDD1Dn) & M;
  };
  return () => (next() << 192n) | (next() << 128n) | (next() << 64n) | next();
}
