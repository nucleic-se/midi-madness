# Contributing

Use Node.js 22.6 or newer and install dependencies with `npm ci`.

```sh
npm run boundary:check
npm run check
npm test
npm run foundation:test
npm run graphics:test
npm run format:check
```

Run focused tests while developing. Before release, validate the compiler, renderer, MIDI backend and shared package tests. `npm run test:examples` compiles the example scores and independently decodes their MIDI exports. Small listening fixtures live under `tests/fixtures/render/`; render output belongs in ignored `renders/`.

Keep changes focused and include regression coverage for behavior changes. Examples and tests must run from a fresh checkout with documented dependencies. Describe supported behavior and current limitations in the documentation.

Use `loadScore(file)` from `packages/core/src/include.ts` for disk inputs. Preserve dependency hashes and source line maps. Included fragments use `.mmi`; complete scores use `.mm`.

Keep package documentation beside its package and general guides under `docs/`. Document changes to parameter mappings and score compatibility in the affected reference, including migration instructions when needed. Preserve shared foundation/graphics exports and the versioned performance sidecar contract; see each package's artifact export guide.

`npm run renders:mp3` converts local mixes using ffmpeg. `npm run test:midi-native` requires a hardware or virtual MIDI port and is separate from CI. Device overrides and listening-feedback files are ignored by Git; use the paths described in the setup and CLI guides.

GitHub CI validates Node 22/Linux. The project is [MIT licensed](LICENSE).
