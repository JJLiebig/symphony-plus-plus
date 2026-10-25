import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOB, PACKAGES, EVENTS } from './mods/sympp-lab/fixtures.js';
import { frameAt, journey, duration } from './mods/sympp-lab/model.js';
import { plan, place, route, ringStops, STOP } from './mods/sympp-lab/floor.js';

const fixture = { packages: PACKAGES, events: EVENTS };
const last = EVENTS.length - 1;

test('the sample job shows every situation the lab is meant to compare', () => {
  const now = frameAt(fixture, last);
  const by = Object.fromEntries(now.packages.map(pkg => [pkg.id, pkg]));
  assert.ok(now.packages.length >= 6);
  assert.ok(new Set(now.packages.map(pkg => pkg.room)).size >= 6);
  const churn = now.packages.find(pkg => pkg.room === 'review');
  assert.equal(churn.round, 4);
  assert.equal(by['install-command'].waitingFor?.id, churn.id);
  assert.equal(by['human-actions'].idleFor, 46);
  assert.equal(by['motion-spike'].noPr && by['motion-spike'].pr, null);
  assert.equal(by['remote-access'].needsFor, 33);
  assert.equal(duration(now.at), '2h 25m');
  assert.equal(JOB.startClock + now.at, 11 * 60 + 35);

  // Time in room restarts on each move; wall time runs from leaving the yard to shipping.
  assert.equal(churn.inRoom, now.at - 71);
  assert.equal(churn.wall, now.at - 9);
  const shipped = by['board-endpoint'];
  assert.equal(shipped.wall, 62 - 4);
  assert.deepEqual(journey(by['human-actions']).map(p => [p.room, p.to - p.from, p.waiting]),
    [['yard', 69, true], ['build', 23, false], ['checks', 7, false], ['checks', 46, true]]);
});

test('every package stands inside its own room at every step, wide and narrow', () => {
  for (const kind of ['wide', 'narrow']) {
    const floor = plan(kind);
    for (let step = 0; step <= last; step++) {
      const frame = frameAt(fixture, step);
      const spots = place(floor, frame.packages);
      for (const pkg of frame.packages) {
        const r = floor.room[pkg.room];
        const s = spots[pkg.id];
        assert.ok(s.x >= r.x && s.y >= r.y && s.x + s.w <= r.x + r.w && s.y + s.h <= r.y + r.h,
          `${kind} step ${step}: ${pkg.id} outside ${pkg.room}`);
      }
    }
  }
});

test('a move walks the corridor and a new review round circles the track clockwise', () => {
  for (const kind of ['wide', 'narrow']) {
    const floor = plan(kind);
    const { corridor } = floor;
    const center = s => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
    const before = place(floor, frameAt(fixture, 3).packages)['board-endpoint'];
    const after = place(floor, frameAt(fixture, 4).packages)['board-endpoint'];
    const legs = route(floor, before, after, 'build', 'checks');
    assert.equal(legs.length, 3);
    for (const leg of legs.slice(0, 2)) {
      const c = center(leg);
      if (corridor.axis === 'x') assert.equal(c.y, corridor.y + corridor.h / 2);
      else assert.equal(c.x, corridor.x + corridor.w / 2);
    }
    assert.deepEqual(legs.at(-1), { ...after, ms: legs.at(-1).ms, easing: legs.at(-1).easing });

    const fix = place(floor, frameAt(fixture, EVENTS.findIndex(e => e.at === 78)).packages)['board-model'];
    const again = place(floor, frameAt(fixture, EVENTS.findIndex(e => e.at === 84)).packages)['board-model'];
    assert.deepEqual([fix.stop, again.stop, again.round], [STOP.fix, STOP.review, 2]);
    const lap = route(floor, fix, again, 'review', 'review');
    const stops = ringStops(floor.room.review.ring);
    assert.deepEqual(lap.map(center), [7, 8, 9, 10, 11, 0].map(i => stops[i]));
  }
});
