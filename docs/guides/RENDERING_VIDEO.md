# Render a score to video

Install the repository dependencies with `npm ci`, and install a local FFmpeg
build providing the `libx264` video and `aac` audio encoders. `ffmpeg` must be on
PATH. On macOS, `brew install ffmpeg`; on Debian/Ubuntu, `sudo apt install ffmpeg`.
No browser, GPU or MIDI device is required.

From the repository root:

```sh
npm run mm -- video examples/first_song.mm --out renders/first-song.mp4
```

This renders the score through the software audio engine, reads its version-1
performance JSON, renders a coloured piano roll and encodes an MP4 with matching
audio. Source scores do not need visual syntax. Includes and data dependencies
use the same loader and provenance as `mm render`.

The default video is 1280×720 at 30 frames per second. An eight-second window
scrolls past a fixed playhead, with one labelled lane per track. Note position
within a lane follows attack pitch; rectangle length follows the scheduled gate.
Drum hits use a 120ms marker. Active markers brighten. These are event activity
indicators, not audible-level meters or reconstructed DSP voices. A fixed palette
cycles through tracks in sidecar order. Track labels use a small uppercase bitmap
font; unsupported characters appear as `?`. Many tracks or small frames reduce
legibility.

For a smaller excerpt:

```sh
npm run mm -- video examples/first_song.mm --from "bar 5" --bars 2 \
  --tail 1 --width 640 --height 360 --fps 24 --out renders/chorus.mp4
```

`--setup` selects an optional software setup. `--from`, `--bars` and `--tail`
follow audio-render semantics, including ordinary excerpt history. Both stereo
and binaural scores work. Four-channel ambisonic movies are currently rejected;
select stereo or binaural in the score before exporting. The audio may already
have been rendered when this channel check reports an error.

Width must be an even integer from 160 to 3840; height must be an even integer
from 120 to 2160. Frame rate must be an integer from 1 to 60. `--out` must end in
`.mp4`; by default it is `renders/<score-basename>/video.mp4`. `--json` returns
the movie, WAV and sidecar paths, dimensions, frame rate, frame count, duration
and preset name. `--quiet` suppresses progress and human-readable results.

For `renders/chorus.mp4`, the command keeps these intermediates:

```text
renders/chorus.mp4
renders/chorus.assets/mix.wav
renders/chorus.assets/mix.events.json
renders/chorus.assets/report.json
renders/chorus.assets/report.txt
```

The sidecar includes all rendered event tracks but omits dense DSP envelope
recordings, which this preset does not use. Its existing version-1 contract is
unchanged. The WAV retains the software renderer's audio quality; the MP4 uses
H.264/yuv420p and lossy AAC stereo at 192 kb/s. Frames are evaluated at `index/fps`
in media seconds, including the excerpt's audio origin. The final frame can extend
the video stream by less than one frame beyond the exact WAV duration. AAC uses
encoder delay/padding as represented by the MP4 timing metadata.

Encoding streams RGB frames to FFmpeg without saving an image sequence. Memory
still includes the normal audio-render buffers and event data. Larger or longer
renders take more time. An existing movie is replaced only after successful
encoding; partial movie files are removed on handled errors. Intermediate audio,
events and reports remain after an encoding failure and are replaced on a retry.

## Other visual treatments

This first CLI preset is a browser-free 2D piano roll. It does not export arbitrary
Three.js scenes, cameras or shaders. Those effects can
consume the same event data, but need a separate scene/frame-capture host.

Graphics consumers can use the headless frame renderer directly:

```js
import { createPianoRoll } from '@midi-madness/graphics/video.js';

const visual = createPianoRoll(events, { width: 640, height: 360, windowSeconds: 8 });
const rgb24 = visual.frame(1.5); // Uint8Array, top-to-bottom RGB bytes
```

This API owns no clock, filesystem or encoder. Repeated or backward time queries
produce the same frames. It shows scheduled pitch/gates and drum attacks; pitch
paths, spatial motion, envelope releases and effect returns are not represented.
