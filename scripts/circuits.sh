#!/usr/bin/env bash
# Kompilon variante te qarqeve. Cdo argument: "<lloji> <nivele> <b>"  (aritet 2^b)
#   lloji: m = anetaresi, u = perditesim, k<K> = grup me K perditesime (p.sh. k4)
#   scripts/circuits.sh "m 20 1" "u 24 1" "k4 24 1"
# Pa argumente kompilon variantet e testit.
set -euo pipefail
cd "$(dirname "$0")/../circuits"

# Kompiluesi (WASI) sheh vetem dosjen ku ekzekutohet: circomlib kopjohet ketu.
if [ ! -d circomlib ]; then
  cp -r ../node_modules/circomlib ./circomlib
fi

configs=("$@")
if [ ${#configs[@]} -eq 0 ]; then
  configs=("m 20 1" "m 32 1" "m 7 3" "m 11 3" "u 24 1" "u 16 2" "u 11 3" "k2 24 1" "k2 11 3")
fi

for cfg in "${configs[@]}"; do
  read -r kind D b <<<"$cfg"
  name="${kind}_b${b}_D${D}"
  case "$kind" in
    m)
      printf 'pragma circom 2.1.6;\ninclude "membership.circom";\ncomponent main {public [root, keyHi, keyLo, value]} = CIPMembership(%s, %s);\n' "$D" "$b" >"$name.circom"
      ;;
    u)
      printf 'pragma circom 2.1.6;\ninclude "update.circom";\ncomponent main {public [oldRoot, newRoot, keyHi, keyLo, newValue]} = CIPUpdate(%s, %s);\n' "$D" "$b" >"$name.circom"
      ;;
    k*)
      printf 'pragma circom 2.1.6;\ninclude "batch.circom";\ncomponent main {public [oldRoot, newRoot, txCommit]} = CIPBatch(%s, %s, %s);\n' "${kind#k}" "$D" "$b" >"$name.circom"
      ;;
    *)
      echo "lloj i panjohur: $kind" >&2
      exit 1
      ;;
  esac
  if [ -f "$name.r1cs" ] && [ -d "${name}_js" ]; then
    echo "$name: ekziston"
    continue
  fi
  echo "== $name"
  npx circom2 "$name.circom" --r1cs --wasm --O2 | grep -iE "constraints|error" || true
  test -f "$name.r1cs"
done
