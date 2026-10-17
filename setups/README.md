# MIDI and software setups

A score names musical parts and parameters. A setup selects the engine or MIDI
instrument, routing and starting patch for each part. The repository includes:

- `band/band.setup`: the default software setup, used by `mm render` by default.
- `example/`: generic MIDI definitions, a setup and a short smoke score.

Store device-specific mappings in `setups/local/` or `*.local.setup` files.
These paths are ignored by Git.

## Try the software renderer

```sh
npm run mm -- check examples/first_song.mm --setup setups/band/band.setup
npm run mm -- render examples/first_song.mm
```

The software setup has no MIDI channel assignments. Parts bind by exact name,
drum lane, role or the fallback synth. See the [renderer guide](../packages/render/README.md).

## Configure a MIDI instrument

Copy `setups/example/` into a local working directory. Replace the output name
with the exact name from `mm ports`, and set channels, bank/program support,
parameter CCs and drum notes from your device's MIDI documentation. The example
numbers are placeholders, not definitions for a particular commercial device.

```sh
npm run mm -- ports
npm run mm -- check setups/example/smoke.mm --setup setups/example/studio.setup
npm run mm -- explain setups/example/smoke.mm --setup setups/example/studio.setup --bar 1 --json
npm run mm -- export setups/example/smoke.mm --setup setups/example/studio.setup --midi renders/smoke.mid
```

After configuring your local setup:

```sh
npm run mm -- play setups/example/smoke.mm --setup setups/local/studio.setup
npm run mm -- play setups/example/smoke.mm --setup setups/local/studio.setup --bars 2..3 --loop
npm run mm -- panic --setup setups/local/studio.setup
```

Instrument parameters use normalized 0–1 values, or −1…1 when declared bipolar.
A setup `set` overrides a definition's startup default; score automation then takes
over. Programs and initialization run once, including during looping.

Ctrl-C stops playback and releases notes (exit 130). `--clock off` disables
transport/clock. Range playback chases controllers, skips notes started before
the selected range, and clips notes at its end. Check and export do not require
connected hardware. Setup-free export is notes-only with automatic pitched
channels and General MIDI drums. Live playback requires an explicit setup.

See the [configuration reference](../docs/reference/INSTRUMENTS.md) for full syntax.
