pragma circom 2.1.6;

include "update.circom";

// Prove ne grup: K kalime gjendjeje te zinxhiruara oldRoot -> r_1 -> ... -> newRoot ne nje prove.
// Hyrjet publike jane vetem tri, pavaresisht nga K:
//   oldRoot, newRoot dhe txCommit = angazhim Poseidon mbi (keyHi, keyLo, newValue) te cdo transaksioni, ne radhe:
//   acc_0 = 0,  acc_{i+1} = Poseidon(acc_i, keyHi_i, keyLo_i, newValue_i),  txCommit = acc_K
template CIPBatch(K, D, b) {
    var n = 1 << b;
    signal input oldRoot;
    signal input newRoot;
    signal input txCommit;

    signal input midRoots[K - 1];     // rrenjet e ndermjetme
    signal input keyHi[K];
    signal input keyLo[K];
    signal input newValue[K];
    signal input oldValue[K];
    signal input otherPath[K];
    signal input otherValue[K];
    signal input isUpdate[K];
    signal input isPush[K];
    signal input children[K][D][n];
    signal input activeOld[K][D];
    signal input activeNew[K][D];

    component upd[K];
    component com[K];
    signal acc[K + 1];
    acc[0] <== 0;
    for (var i = 0; i < K; i++) {
        upd[i] = CIPUpdate(D, b);
        if (i == 0) {
            upd[i].oldRoot <== oldRoot;
        } else {
            upd[i].oldRoot <== midRoots[i - 1];
        }
        if (i == K - 1) {
            upd[i].newRoot <== newRoot;
        } else {
            upd[i].newRoot <== midRoots[i];
        }
        upd[i].keyHi <== keyHi[i];
        upd[i].keyLo <== keyLo[i];
        upd[i].newValue <== newValue[i];
        upd[i].oldValue <== oldValue[i];
        upd[i].otherPath <== otherPath[i];
        upd[i].otherValue <== otherValue[i];
        upd[i].isUpdate <== isUpdate[i];
        upd[i].isPush <== isPush[i];
        for (var l = 0; l < D; l++) {
            for (var j = 0; j < n; j++) {
                upd[i].children[l][j] <== children[i][l][j];
            }
            upd[i].activeOld[l] <== activeOld[i][l];
            upd[i].activeNew[l] <== activeNew[i][l];
        }

        com[i] = Poseidon(4);
        com[i].inputs[0] <== acc[i];
        com[i].inputs[1] <== keyHi[i];
        com[i].inputs[2] <== keyLo[i];
        com[i].inputs[3] <== newValue[i];
        acc[i + 1] <== com[i].out;
    }
    txCommit === acc[K];
}
