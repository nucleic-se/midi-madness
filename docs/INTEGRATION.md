# CLI and library integration

Use the CLI for file-based score operations. Use the shared libraries for time, parameter evaluation and performance graphics in an application.

## Call the CLI from a script

Build foundation once before invoking the CLI directly:

```sh
npm run foundation:build
node --experimental-strip-types packages/cli/src/main.ts check examples/first_song.mm --setup setups/band/band.setup --json
```

With `--json`, stdout contains one object with `schemaVersion`, `command`, `file`, `engine`, `result`, `diagnostics` and `summary`. A command's result is specific to that command. `schema check` describes the envelope and diagnostic shape; it does not define every result field.

Exit status is 0 when there are no errors, 1 for diagnostics containing errors, and 2 for usage or I/O failures. Use diagnostics and exit status together. See [CLI reference](reference/TOOLING.md) for the complete command set.

## Consume a rendered performance

A mixed render writes a WAV and a matching `<wav-stem>.events.json` file. The sidecar uses the `midi-madness-performance` version-1 format and records scheduled events, control lanes, resolved instrument inputs and recorded envelopes.

Convert a backend sample coordinate to media seconds with:

```js
const seconds = (sample - document.audio.originSample) / document.audio.sampleRate;
```

Keep signed pre-excerpt events and control history when reconstructing state. Recorded envelopes describe voice state, not post-DSP loudness or wet-bus waveforms. See the [renderer sidecar documentation](../packages/render/README.md#performance-sidecar) and [spatial export contract](../packages/render/SPATIAL.md#export-contract-mixeventsjson).

The graphics package's `performance-adapter.js` converts version-1 renderer data into performance inputs. Its default engine contains note gates; reconstructing actual voice lifetimes requires the documented resolver or resolved performance data. See [Graphics](../packages/graphics/README.md#renderer-export-adapter).

## Use the shared libraries

| Package | API |
|---|---|
| `@midi-madness/foundation` | `/time`, `/curves`, `/envelopes`, `/parameters` |
| `@midi-madness/graphics` | Headless engine/adapters and graphics modules under documented `.js` entry points |

Foundation has no runtime dependencies. Graphics requires the exact peer versions declared in its package: foundation `0.2.0` and Three.js `0.180.0`. Use headless graphics subpaths when the application does not need Three.js.

```sh
npm run foundation:build
npm run graphics:build
```

For API details, see [Foundation](../packages/foundation/README.md) and [Graphics](../packages/graphics/README.md). Their package manifests define the exported entry points.

## Export versioned packages

After committing package source, export tarballs into a consuming application's vendor directory:

```sh
node scripts/pack-shared.mjs foundation /absolute/path/to/consumer/vendor
node scripts/pack-shared.mjs graphics /absolute/path/to/consumer/vendor
```

The script refuses uncommitted changes in the selected package or packaging script and refuses to overwrite an existing artifact version. Each tarball has an adjacent JSON record with source commit/tree, file list and npm integrity.

Install the tarballs in the consuming application, along with the required peers, and retain its lockfile and provenance records. Changed package contents require a new version. The score language's literal compatibility contract is documented separately in [Literal profile 1](reference/LITERAL_V1.md).
