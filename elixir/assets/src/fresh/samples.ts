// Sample architect wording, so the sketch can be judged with real-sounding reports.
// Nothing here comes from the ledger: the architect would write the brief and the ETA.
// Wording for real goals is operator-owned and loaded from outside the repository.
export type Sample = { brief: string; eta?: string; always?: boolean };
export type SampleRule = [pattern: string, sample: Sample];

const MOCK_SAMPLES: SampleRule[] = [
  ["Creator payouts v2", { always: true, brief: "The backend is done and most of the API is merged. Two packages are dragging: webhook retries are on their third review round, and idempotency keys have failing checks. Console UI has started in parallel.", eta: "API finished today if round three passes; UI later this week" }],
  ["Quote engine", { always: true, brief: "Four of seven carrier adapters are in and the rest are moving. I need production credentials for two carriers before their adapters can be verified.", eta: "Adapters done tomorrow once the credentials arrive" }],
  ["signed playback", { always: true, brief: "Everything is merged, but the dev deploy failed on the migration step. I am rerunning it now.", eta: "On dev within the hour if the rerun passes" }],
  ["per-step timing", { always: true, brief: "All four packages are merged and live. Step timings now show in every fast review." }],
];

let samples: Array<[RegExp, Sample]> = compile(MOCK_SAMPLES);

function compile(list: SampleRule[]): Array<[RegExp, Sample]> {
  return list.map(([pattern, sample]) => [new RegExp(pattern, "i"), sample]);
}

export function setSamples(local: SampleRule[]) {
  samples = compile([...local, ...MOCK_SAMPLES]);
}

// Real goals only borrow sample wording while they are on track; the mock goals always carry theirs.
export function sampleReport(goalTitle: string, onTrack: boolean) {
  const sample = samples.find(([pattern]) => pattern.test(goalTitle))?.[1] ?? null;
  return sample && (onTrack || sample.always) ? sample : null;
}
