pragma circom 2.1.6;

include "membership.circom";

// Nje nivel i kalimit te gjendjes. Tri lloje nivelesh:
//   - i vjeter (activeOld = activeNew = 1): nyja ekziston ne pemen e vjeter; femija ne shtegun tone
//     zevendesohet me vleren e re.
//   - zgjatim (activeOld = 0, activeNew = 1): nyje e re qe krijohet kur gjethja e re shtyn poshte nje
//     gjethe tjeter. Te gjithe femijet jane 0, pervec gjethes tjeter ne nivelin e fundit.
//   - joaktiv: vlerat kalojne pa ndryshim.
template UpdLevel(b) {
    var n = 1 << b;
    signal input curOld;
    signal input curNew;
    signal input children[n];
    signal input bits[b];      // shifra e shtegut tone
    signal input obits[b];     // shifra e shtegut te gjethes tjeter
    signal input activeOld;
    signal input activeNew;
    signal input isLast;       // 1 vetem ne nivelin e fundit te zgjatimit
    signal input otherLeaf;
    signal output outOld;
    signal output outNew;

    component oh = OneHot(b);
    component oo = OneHot(b);
    for (var m = 0; m < b; m++) {
        oh.bits[m] <== bits[m];
        oo.bits[m] <== obits[m];
    }

    // Pema e vjeter: femija ne pozicionin tone eshte curOld.
    signal p[n];
    var acc = 0;
    for (var j = 0; j < n; j++) {
        p[j] <== oh.out[j] * (children[j] - curOld);
        acc += p[j];
    }
    signal matchOld <== acc;
    activeOld * matchOld === 0;

    // Niveli zgjatim: forma e femijeve eshte e detyruar.
    signal ext <== activeNew - activeOld;
    signal lastOther <== isLast * otherLeaf;
    signal t[n];
    signal eq[n];
    var e = 0;
    for (var j = 0; j < n; j++) {
        t[j] <== oo.out[j] * lastOther;
        ext * (children[j] - t[j]) === 0;
        eq[j] <== oh.out[j] * oo.out[j];
        e += eq[j];
    }
    signal same <== e;                 // 1 nese dy shifrat jane te barabarta
    ext * (same - 1 + isLast) === 0;   // te barabarta para nivelit te fundit, te ndryshme ne te fundit

    component hOld = Poseidon(n);
    component hNew = Poseidon(n);
    signal nc[n];
    for (var j = 0; j < n; j++) {
        hOld.inputs[j] <== children[j];
        nc[j] <== children[j] + oh.out[j] * (curNew - children[j]);
        hNew.inputs[j] <== nc[j];
    }
    outOld <== curOld + activeOld * (hOld.out - curOld);
    outNew <== curNew + activeNew * (hNew.out - curNew);
}

// Kalim gjendjeje oldRoot -> newRoot per (key, newValue): futje ne vend bosh, perditesim i vleres,
// ose futje qe shtyn poshte nje gjethe ekzistuese. D nivele fikse, aritet 2^b.
template CIPUpdate(D, b) {
    var n = 1 << b;
    signal input oldRoot;
    signal input newRoot;
    signal input keyHi;
    signal input keyLo;
    signal input newValue;

    signal input oldValue;      // vlera e meparshme (kur isUpdate = 1)
    signal input otherPath;     // shtegu dhe vlera e gjethes qe shtyhet (kur isPush = 1)
    signal input otherValue;
    signal input isUpdate;
    signal input isPush;
    signal input children[D][n];
    signal input activeOld[D];  // 1 per nivelet 0..d-1 te pemes se vjeter
    signal input activeNew[D];  // 1 per nivelet 0..d'-1 te pemes se re, d' >= d

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
    component obits = Num2Bits_strict();
    obits.in <== otherPath;

    component newLeaf = Poseidon(3);
    newLeaf.inputs[0] <== path.out;
    newLeaf.inputs[1] <== newValue;
    newLeaf.inputs[2] <== 1;
    component sameLeaf = Poseidon(3);
    sameLeaf.inputs[0] <== path.out;
    sameLeaf.inputs[1] <== oldValue;
    sameLeaf.inputs[2] <== 1;
    component otherLeaf = Poseidon(3);
    otherLeaf.inputs[0] <== otherPath;
    otherLeaf.inputs[1] <== otherValue;
    otherLeaf.inputs[2] <== 1;

    isUpdate * (isUpdate - 1) === 0;
    isPush * (isPush - 1) === 0;
    isUpdate * isPush === 0;

    // Vlera ne vendin ku mbaron shtegu i vjeter: 0, gjethja jone e vjeter, ose gjethja tjeter.
    signal s1 <== isUpdate * sameLeaf.out;
    signal s2 <== isPush * otherLeaf.out;
    signal oldSlot <== s1 + s2;

    signal isLast[D];
    var sumExt = 0;
    var sumLast = 0;
    for (var i = 0; i < D; i++) {
        activeOld[i] * (activeOld[i] - 1) === 0;
        activeNew[i] * (activeNew[i] - 1) === 0;
        activeOld[i] * (1 - activeNew[i]) === 0;
        if (i < D - 1) {
            activeOld[i + 1] * (1 - activeOld[i]) === 0;
            activeNew[i + 1] * (1 - activeNew[i]) === 0;
            isLast[i] <== (activeNew[i] - activeOld[i]) * (1 - activeNew[i + 1]);
        } else {
            isLast[i] <== activeNew[i] - activeOld[i];
        }
        sumExt += activeNew[i] - activeOld[i];
        sumLast += isLast[i];
    }
    signal nExt <== sumExt;
    signal nLast <== sumLast;
    (1 - isPush) * nExt === 0;     // zgjatim vetem kur shtyhet nje gjethe
    isPush * (1 - nLast) === 0;    // dhe atehere te pakten nje nivel

    component lvl[D];
    signal curOld[D + 1];
    signal curNew[D + 1];
    curOld[D] <== oldSlot;
    curNew[D] <== newLeaf.out;
    for (var i = D - 1; i >= 0; i--) {
        lvl[i] = UpdLevel(b);
        lvl[i].curOld <== curOld[i + 1];
        lvl[i].curNew <== curNew[i + 1];
        for (var j = 0; j < n; j++) {
            lvl[i].children[j] <== children[i][j];
        }
        for (var m = 0; m < b; m++) {
            lvl[i].bits[m] <== bits.out[i * b + m];
            lvl[i].obits[m] <== obits.out[i * b + m];
        }
        lvl[i].activeOld <== activeOld[i];
        lvl[i].activeNew <== activeNew[i];
        lvl[i].isLast <== isLast[i];
        lvl[i].otherLeaf <== otherLeaf.out;
        curOld[i] <== lvl[i].outOld;
        curNew[i] <== lvl[i].outNew;
    }
    oldRoot === curOld[0];
    newRoot === curNew[0];
}
