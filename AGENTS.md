# Development guide

The repository implements the midi-madness score language, compiler, CLI, MIDI backends, software renderer, foundation and graphics libraries. Source lives in packages/, examples in examples/, regression fixtures in tests/, and guides and references in docs/.

Keep changes focused on the affected package. Disk-based score inputs use loadScore(file) so includes, data dependencies and source locations remain consistent across commands. Examples must run from a fresh checkout.

Document supported behavior and current limitations. Document language, parameter-mapping and sound-compatibility changes with the affected reference. Preserve exported foundation/graphics interfaces and the versioned performance sidecar contract. Changed package contents require a new version; released tarballs are immutable.

Use focused tests while developing. Release validation:

```sh
npm run boundary:check
npm run check
npm test
npm run foundation:test
npm run graphics:test
npm run format:check
```

See CONTRIBUTING.md for setup, validation and documentation conventions.
