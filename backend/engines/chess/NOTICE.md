# Source and development dependencies

This engine derives from the user's v0.1.6 delivery; [SOURCE.json](SOURCE.json) identifies the immutable archive. The repository owns subsequent changes. The original archive retains its rules/source attribution documents. No original archive has been modified and no historical report is presented as a fresh execution.

There are no runtime third-party dependencies. The backend root lockfile pins TypeScript 6.0.3 (Apache-2.0) and chess.js 1.4.0 (BSD-2-Clause) for development and independent movement tests. Dependency licenses remain with their npm packages; chess.js code is not copied into this engine.

Inherited numeric perft fixtures include the standard positions documented by [Chess Programming Wiki](https://www.chessprogramming.org/Perft_Results); their original release attribution is in the supplied v0.1.6 archive's `docs/RULES_AND_SOURCES.md`. Test counts and selected graphs do not establish formal correctness or an exhaustive independent audit.

The package remains private. No ownership or licensing terms for the existing project are changed.
