# ori

Pemë Poseidon (CIP-MPT) mbi BN254 me prova Groth16: anëtarësi dhe përditësim gjendjeje, aritet 2, 4 ose 8.

**Gjendja: eksperimentale. Jo për prodhim.** Setup-i Groth16 është vetëm për zhvillim (pa ceremoni të besuar) dhe kodi nuk është audituar.

## Çfarë ka këtu

| Dosja | Përmbajtja |
| --- | --- |
| `js/` | Implementimi referencë i pemës (`trie.mjs`), testet dhe skriptet e matjes |
| `circuits/` | `membership.circom` (anëtarësi) dhe `update.circom` (kalim gjendjeje) |
| `scripts/circuits.sh` | Kompilon variantet e qarqeve |
| `contracts/` | Verifikuesi Solidity i gjeneruar dhe testi Foundry që mat gazin |
| `rollups/` | Shënime për Fazën 2 |

## Testet në GitHub Actions

- **`ci`** (çdo push dhe PR): testet e pemës me Poseidon real dhe testet e qarkut të përditësimit, me kalime të vlefshme dhe 13 falsifikime për aritet.
- **`claims`** (push në `main` ose manualisht): mat metrikat e tabelës fillestare të studimit (kufizime R1CS, kohë prove, madhësi dëshmie, gaz verifikimi në L1) dhe i krahason me pohimet. Tabela del te përmbledhja e punës (job summary).

## Ekzekutimi lokal

```bash
npm ci
```

```bash
bash scripts/circuits.sh
```

```bash
npm test
```

```bash
node js/claims.mjs 14
```

## Modeli

- Shtegu: `a(k) = Poseidon(k_hi, k_lo)`; shifra `i` e shtegut zgjedh fëmijën në nivelin `i`.
- Gjethja: `Poseidon(a, v, 1)`; nyja: `Poseidon(fëmijët)`; nënpema bosh ka hesh 0.
- Gjethja vendoset në thellësinë e parë ku shtegu i saj është unik, ndaj rrënja varet vetëm nga bashkësia e çifteve (çelës, vlerë).
- Kostoja e matur e qarkut binar: anëtarësi `1012 + 246·D` kufizime, përditësim `2048 + 501·D`.

## Plani

1. Port i pemës dhe i provuesit në Rust (CPU), me teste kryqëzuese kundrejt këtij implementimi.
2. Qarku i provës në grup.
3. Prapavijë GPU.
