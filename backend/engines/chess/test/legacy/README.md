# Authentic historical snapshot fixtures

The v0.1.1, v0.1.2, v0.1.3, v0.1.4 and v0.1.5 JSON snapshots were generated and restored using their unchanged original compiled releases. They are synthetic regression fixtures, not authenticated participant histories or evidence of standard-start reachability.

The current engine rejects all earlier versions as UNSUPPORTED_VERSION. Changing only engineVersion is not migration: stronger recognition can end a historical cage, occupancy, castling or finite-tempo/castling root before its recorded continuation. Standard-root snapshots also require their original version even when their board looks identical.

The cage-after-move, occupancy-after-move , castling-after-e1-d1 and tempo-after-e1-d1 fixtures contain actual actions accepted by their original engines. New replay rejects those extra actions after its earlier automatic ending. Preserve original snapshots and original engines for authoritative historical replay.

The v0.1.5 temporal-castling fixtures include the original playing root, its accepted c2–c4 continuation, its explicitly proved final draw, and a standard root. They were generated with the original v0.1.5 engine. v0.1.6 must not silently replay an earlier proof or move after its new creation-time automatic ending.

The three v0.1.6 fixtures were freshly generated during takeover by executing its untouched compiled archive identified in `../../SOURCE.json`: a standard root, the new KQ/knight/tempo playing root and its accepted c2–c4 continuation. The current engine rejects them without changing their version or replaying a move after its earlier ending.

The v0.2.0 standard and king-corridor roots were generated from the unchanged compiled 0.2.0 engine immediately before the 0.3.0 correction. Both retain the original rules-v1 binding. The king-corridor root was incorrectly playing; relabelling both version fields cannot migrate it across the new creation-time draw. The published standard proof game is retained separately as source provenance and a replay regression.
