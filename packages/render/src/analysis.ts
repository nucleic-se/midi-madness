import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeWav } from './wav.ts';
import type { Stereo } from '../../synth/src/buses.ts';

type Region = { name: string; from: number; to: number };
export function levels(audio: Stereo, regions: Region[]) {
  return regions.map((region) => {
    const from = Math.max(0, region.from),
      to = Math.min(audio.left.length, region.to);
    let energy = 0,
      peak = 0;
    for (let i = from; i < to; i++) {
      energy += audio.left[i] ** 2 + audio.right[i] ** 2;
      peak = Math.max(peak, Math.abs(audio.left[i]), Math.abs(audio.right[i]));
    }
    return {
      name: region.name,
      rmsDb: 10 * Math.log10(Math.max(1e-20, energy / Math.max(1, 2 * (to - from)))),
      peakDb: 20 * Math.log10(Math.max(1e-10, peak)),
    };
  });
}
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export function createAnalysis(
  destination: string,
  sr: number,
  from: number,
  sections: Region[],
  bars: Region[],
) {
  const directory = join(dirname(destination), 'analysis');
  mkdirSync(join(directory, 'stems'), { recursive: true });
  const members: {
    name: string;
    stem: string;
    spectrum: string | null;
    sections: ReturnType<typeof levels>;
    bars: ReturnType<typeof levels>;
  }[] = [];
  const warnings: string[] = [];
  const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (!available)
    warnings.push(
      'ffmpeg unavailable: spectrograms omitted; stems and level measurements are available',
    );
  function spectrum(input: string, file: string, start?: number, duration?: number) {
    if (!available) return null;
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (start !== undefined) args.push('-ss', String(start));
    if (duration !== undefined) args.push('-t', String(duration));
    args.push(
      '-i',
      input,
      '-lavfi',
      'showspectrumpic=s=1400x400:legend=1:scale=log:fscale=log:color=intensity',
      '-frames:v',
      '1',
      join(directory, file),
    );
    const result = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) {
      warnings.push(`Spectrogram ${file} failed: ${result.error?.message ?? result.stderr.trim()}`);
      return null;
    }
    return file;
  }
  return {
    member(name: string, audio: Stereo) {
      const slug = encodeURIComponent(name),
        stem = `stems/${slug}.wav`;
      writeWav(join(directory, stem), audio.left, audio.right, sr, from, audio.left.length, true);
      members.push({
        name,
        stem,
        spectrum: spectrum(join(directory, stem), `${slug}.png`),
        sections: levels(audio, sections),
        bars: levels(audio, bars),
      });
    },
    finish(audio: Stereo, to: number, title: string) {
      const mixSections = sections
        .filter((s) => s.to > from && s.from < to)
        .map((s, i) => {
          const start = Math.max(from, s.from),
            end = Math.min(to, s.to);
          return {
            name: s.name,
            spectrum: spectrum(
              destination,
              `section-${i + 1}.png`,
              (start - from) / sr,
              (end - start) / sr,
            ),
          };
        });
      const mix = {
        spectrum: spectrum(destination, 'mix.png'),
        sections: levels(audio, sections),
        bars: levels(audio, bars),
      };
      const report = {
        title,
        sampleRate: sr,
        excerptFromSeconds: from / sr,
        measurement:
          'Unweighted stereo RMS dBFS, not LUFS; member stems include inserts but exclude shared bus returns',
        mix,
        members,
        mixSections,
        warnings,
      };
      writeFileSync(join(directory, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
      const table = (rows: ReturnType<typeof levels>) =>
        `<table><tr><th>Region</th><th>RMS dBFS</th><th>Peak dBFS</th></tr>${rows.map((r) => `<tr><td>${escape(r.name)}</td><td>${r.rmsDb.toFixed(1)}</td><td>${r.peakDb.toFixed(1)}</td></tr>`).join('')}</table>`;
      const picture = (file: string | null) =>
        file ? `<img src="${escape(file)}" alt="Log frequency spectrogram">` : '';
      writeFileSync(
        join(directory, 'index.html'),
        `<!doctype html><meta charset="utf-8"><title>${escape(title)} — ears</title><style>body{font:16px system-ui;max-width:1400px;margin:32px auto;padding:0 20px;background:#151a23;color:#e6e9ed}img{width:100%}table{border-collapse:collapse}td,th{padding:5px 18px;text-align:left;border-bottom:1px solid #394250}audio{width:100%}details{margin:18px 0}a{color:#85cfff}</style><h1>${escape(title)}</h1><p>${escape(report.measurement)}. Original bar numbers are preserved. Detailed bar measurements: <a href="analysis.json">JSON</a>.</p>${warnings.map((w) => `<p>${escape(w)}</p>`).join('')}<h2>Mix</h2>${picture(mix.spectrum)}${table(mix.sections)}${mixSections.map((s) => `<details><summary>${escape(s.name)}</summary>${picture(s.spectrum)}</details>`).join('')}<h2>Members</h2>${members.map((m) => `<details><summary>${escape(m.name)}</summary><audio controls src="${escape(m.stem)}"></audio>${picture(m.spectrum)}${table(m.sections)}</details>`).join('')}`,
      );
      return { directory, page: join(directory, 'index.html'), warnings };
    },
  };
}
