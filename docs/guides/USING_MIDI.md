# Using MIDI

MIDI output sends notes and controls to instruments. It does not carry the software renderer's audio, presets or effect buses. Per-note paths and grain rendering are not reproduced over MIDI; the backend reports a warning for those events.

## Export a MIDI file

```sh
npm run mm -- export examples/first_song.mm --midi first-song.mid
```

Without a setup, export assigns pitched parts to channels 1–16, skipping channel 10, and maps supported General MIDI drums to channel 10. It exports notes only. More than fifteen pitched parts or an unknown drum lane requires an explicit setup.

Export does not require connected hardware. To export with device-specific mappings:

```sh
npm run mm -- check setups/example/smoke.mm --setup setups/example/studio.setup
npm run mm -- export setups/example/smoke.mm --setup setups/example/studio.setup --midi smoke.mid
```

The example's device and port names are placeholders. MIDI files preserve the configured mappings; your instrument must support them to produce the intended result.

## Configure your instrument

Copy the files under `setups/example/` into `setups/local/`, which Git ignores. Adapt the definitions using your device's MIDI documentation.

| File | Purpose |
|---|---|
| `.mm` | Musical parts, notes and named parameters |
| `.inst` | Device voices, note maps, parameter/controller mappings and constraints |
| `.setup` | Part bindings, output names, channels, programs and startup values |

List available output names without sending messages:

```sh
npm run mm -- ports
```

Set the output name in your setup to the exact name returned by `ports`. Configure channels, bank/program numbering and controller mappings for the device. See [Setups](../../setups/README.md) for a walkthrough and [Instruments and setups](../reference/INSTRUMENTS.md) for the full syntax.

## Play and stop

After saving your configuration as `setups/local/studio.setup`:

```sh
npm run mm -- play setups/example/smoke.mm --setup setups/local/studio.setup
npm run mm -- play setups/example/smoke.mm --setup setups/local/studio.setup --bars 2..3 --loop
```

Live playback requires an explicit setup. Startup patches and defaults run once. Range entry restores controllers and skips notes that began before the range. `--clock off` disables transport and clock messages.

Ctrl-C stops playback and releases notes. To send explicit note-offs, all-notes-off and all-sound-off to the configured channels:

```sh
npm run mm -- panic --setup setups/local/studio.setup
```

Check the [MIDI output rules](../reference/INSTRUMENTS.md#42-midi-10-output-rules-normative-for-the-midi-10-backend) for controller scheduling, device constraints and port capacity.
