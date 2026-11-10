// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Verifikuesi Groth16 i qarkut CIPBatch (tri hyrje publike: oldRoot, newRoot, txCommit).
interface IBatchVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata pub
    ) external view returns (bool);
}

/// Mban rrenjen e gjendjes CIP-MPT ne L1 dhe e ndryshon vetem me nje prove te vlefshme grupi.
///
/// EKSPERIMENTALE - jo per prodhim. Cfare garanton dhe cfare jo:
///  - Garanton: cdo rrenje e re eshte rezultat i sakte i K futjeve/perditesimeve mbi rrenjen aktuale.
///  - Mbrojtja nga ripersrritja: rrenja e vjeter merret nga ruajtja, jo nga thirresi, ndaj nje prove
///    e perdorur nuk vlen me pasi rrenja ka ndryshuar.
///  - NUK garanton vlefshmerine e transaksioneve (nenshkrime, balanca): qarku provon vetem strukturen
///    e pemes. Prandaj vetem operatori mund te dergoje grupe.
///  - NUK garanton disponueshmerine e te dhenave: `txCommit` eshte angazhim Poseidon, i cili nuk
///    rillogaritet ne zinxhir. Te dhenat e transaksioneve duhen publikuar vecmas.
contract OriState {
    /// Rendi i fushes skalare te BN254; hyrjet publike duhet te jene me te vogla.
    uint256 public constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IBatchVerifier public immutable verifier;
    /// Numri i transaksioneve per grup, i fiksuar nga qarku.
    uint256 public immutable batchSize;

    address public operator;
    address public pendingOperator;
    uint256 public stateRoot;
    uint256 public batchCount;

    event BatchApplied(uint256 indexed index, uint256 oldRoot, uint256 newRoot, uint256 txCommit);
    event OperatorTransferStarted(address indexed current, address indexed pending);
    event OperatorChanged(address indexed previous, address indexed current);

    error NotOperator();
    error NotPendingOperator();
    error ZeroAddress();
    error NotInField();
    error RootUnchanged();
    error InvalidProof();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IBatchVerifier verifier_, uint256 genesisRoot, uint256 batchSize_, address operator_) {
        if (address(verifier_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        if (genesisRoot >= FIELD) revert NotInField();
        verifier = verifier_;
        batchSize = batchSize_;
        operator = operator_;
        stateRoot = genesisRoot;
        emit OperatorChanged(address(0), operator_);
    }

    /// Zbaton nje grup: kalon nga `stateRoot` aktual te `newRoot`, nese prova eshte e vlefshme.
    function submitBatch(
        uint256 newRoot,
        uint256 txCommit,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external onlyOperator {
        if (newRoot >= FIELD || txCommit >= FIELD) revert NotInField();
        uint256 oldRoot = stateRoot;
        if (newRoot == oldRoot) revert RootUnchanged();
        if (!verifier.verifyProof(a, b, c, [oldRoot, newRoot, txCommit])) revert InvalidProof();
        stateRoot = newRoot;
        uint256 index = batchCount;
        batchCount = index + 1;
        emit BatchApplied(index, oldRoot, newRoot, txCommit);
    }

    /// Kalimi i rolit te operatorit behet me dy hapa, qe nje adrese e gabuar te mos e bllokoje kontraten.
    function transferOperator(address next) external onlyOperator {
        if (next == address(0)) revert ZeroAddress();
        pendingOperator = next;
        emit OperatorTransferStarted(operator, next);
    }

    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert NotPendingOperator();
        emit OperatorChanged(operator, msg.sender);
        operator = msg.sender;
        pendingOperator = address(0);
    }
}
