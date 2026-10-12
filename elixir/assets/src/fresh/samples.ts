// Sample architect wording for goals whose architect has not reported yet, so the sketch can be judged
// with real-sounding reports. It is operator-owned and loaded from outside the repository.
export type Sample = { brief: string; eta?: string };
export type SampleRule = [pattern: string, sample: Sample];

let samples: Array<[RegExp, Sample]> = [];

export function setSamples(local: SampleRule[]) {
  samples = local.map(([pattern, sample]) => [new RegExp(pattern, "i"), sample]);
}

// A goal only borrows sample wording while it is on track.
export function sampleReport(goalTitle: string, onTrack: boolean) {
  const sample = samples.find(([pattern]) => pattern.test(goalTitle))?.[1] ?? null;
  return sample && onTrack ? sample : null;
}
