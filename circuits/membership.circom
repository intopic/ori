pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

// Zgjedhes one-hot nga b bit: out[j] = 1 vetem per j = numri i koduar nga bitet.
template OneHot(b) {
    signal input bits[b];
    signal output out[1 << b];
    // niveli k ze pozicionet [2^(k+1) - 2, 2^(k+2) - 2)
    signal s[(1 << (b + 1)) - 2];
    s[0] <== 1 - bits[0];
    s[1] <== bits[0];
    for (var k = 1; k < b; k++) {
        var prev = (1 << k) - 2;
        var cur = (1 << (k + 1)) - 2;
        for (var j = 0; j < (1 << k); j++) {
            s[cur + j + (1 << k)] <== s[prev + j] * bits[k];
            s[cur + j] <== s[prev + j] - s[cur + j + (1 << k)];
        }
    }
    for (var j = 0; j < (1 << b); j++) {
        out[j] <== s[(1 << b) - 2 + j];
    }
}

// Nje nivel me aritet 2^b: femija ne pozicionin e shifres duhet te jete cur;
// nese active = 1 dalja eshte heshi i femijeve, perndryshe kalon cur.
template Level(b) {
    var n = 1 << b;
    signal input cur;
    signal input children[n];
    signal input bits[b];     // boolean (garantohet nga Num2Bits)
    signal input active;      // boolean (kontrollohet jashte)
    signal output out;

    component oh = OneHot(b);
    for (var m = 0; m < b; m++) {
        oh.bits[m] <== bits[m];
    }
    signal prod[n];
    var acc = 0;
    for (var j = 0; j < n; j++) {
        prod[j] <== oh.out[j] * (children[j] - cur);
        acc += prod[j];
    }
    signal match <== acc;
    active * match === 0;

    component h = Poseidon(n);
    for (var j = 0; j < n; j++) {
        h.inputs[j] <== children[j];
    }
    out <== cur + active * (h.out - cur);
}

// Deshmi anetaresie per (key, value) nen rrenjen root: D nivele me aritet 2^b.
template CIPMembership(D, b) {
    var n = 1 << b;
    signal input root;
    signal input keyHi;
    signal input keyLo;
    signal input value;
    signal input children[D][n];
    signal input active[D];   // 1 per nivelet 0..d-1, 0 me pas

    component path = Poseidon(2);
    path.inputs[0] <== keyHi;
    path.inputs[1] <== keyLo;

    // Gjysmat e celesit duhet te jene 128-biteshe: perndryshe i njejti celes 256-bitesh do te kishte
    // disa paraqitje (hi - 1, lo + 2^128) me shtigje te ndryshme, pra dy gjethe per nje celes.
    component hiRange = Num2Bits(128);
    hiRange.in <== keyHi;
    component loRange = Num2Bits(128);
    loRange.in <== keyLo;

    component bits = Num2Bits_strict();
    bits.in <== path.out;

    component leaf = Poseidon(3);
    leaf.inputs[0] <== path.out;
    leaf.inputs[1] <== value;
    leaf.inputs[2] <== 1;

    for (var i = 0; i < D; i++) {
        active[i] * (active[i] - 1) === 0;
    }
    for (var i = 0; i < D - 1; i++) {
        active[i + 1] * (1 - active[i]) === 0;   // nivelet aktive jane nje parashtese
    }

    component lvl[D];
    signal cur[D + 1];
    cur[D] <== leaf.out;
    for (var i = D - 1; i >= 0; i--) {
        lvl[i] = Level(b);
        lvl[i].cur <== cur[i + 1];
        for (var j = 0; j < n; j++) {
            lvl[i].children[j] <== children[i][j];
        }
        for (var m = 0; m < b; m++) {
            lvl[i].bits[m] <== bits.out[i * b + m];
        }
        lvl[i].active <== active[i];
        cur[i] <== lvl[i].out;
    }
    root === cur[0];
}
