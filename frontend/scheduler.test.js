const test = require('node:test');
const assert = require('node:assert');
const { TempoClock, computeMeasureStarts, snapLoopStart, snapLoopEnd, effectiveDurationQL, ticksForFutureTime } = require('./scheduler.js');

test('timeAt(0) equals the reference real time', () => {
  const clock = new TempoClock(60);
  clock.reset(10, 0);
  assert.strictEqual(clock.timeAt(0), 10);
});

test('at 60 BPM, 1 quarter length is 1 second', () => {
  const clock = new TempoClock(60);
  clock.reset(0, 0);
  assert.strictEqual(clock.timeAt(1), 1);
});

test('at 50 BPM, 1 quarter length is 1.2 seconds', () => {
  const clock = new TempoClock(50);
  clock.reset(0, 0);
  assert.strictEqual(clock.timeAt(1), 1.2);
});

test('setBpm keeps the current logical position fixed at the moment of change', () => {
  const clock = new TempoClock(60); // 1 sec/beat
  clock.reset(0, 0);
  clock.setBpm(120, 5); // 5 seconds in at 60 BPM = offset 5; now switch to 120 BPM (0.5 sec/beat)
  assert.strictEqual(clock.offsetAt(5), 5);
  assert.strictEqual(clock.timeAt(6), 5.5);
});

test('computeMeasureStarts returns one entry per measure', () => {
  const beats = [
    { offsetQL: 0, measure: 1 }, { offsetQL: 1, measure: 1 }, { offsetQL: 2, measure: 1 },
    { offsetQL: 3, measure: 2 }, { offsetQL: 4, measure: 2 }, { offsetQL: 5, measure: 2 },
  ];
  assert.deepStrictEqual(computeMeasureStarts(beats), [
    { offsetQL: 0, measure: 1 },
    { offsetQL: 3, measure: 2 },
  ]);
});

test('snapLoopStart snaps to the start of the containing measure', () => {
  const starts = [{ offsetQL: 0, measure: 1 }, { offsetQL: 3, measure: 2 }, { offsetQL: 6, measure: 3 }];
  assert.strictEqual(snapLoopStart(4, starts), 3);
  assert.strictEqual(snapLoopStart(3, starts), 3);
  assert.strictEqual(snapLoopStart(0, starts), 0);
});

test('snapLoopEnd snaps to the start of the next measure, or the piece end if in the last measure', () => {
  const starts = [{ offsetQL: 0, measure: 1 }, { offsetQL: 3, measure: 2 }, { offsetQL: 6, measure: 3 }];
  assert.strictEqual(snapLoopEnd(4, starts, 9), 6);
  assert.strictEqual(snapLoopEnd(7, starts, 9), 9);
});

test('effectiveDurationQL extends a note whose start falls inside a pedal span', () => {
  const note = { startQL: 2, durationQL: 1 };
  const pedalEvents = [{ onQL: 1, offQL: 5 }];
  assert.strictEqual(effectiveDurationQL(note, pedalEvents), 3); // 5 - 2
});

test('effectiveDurationQL leaves a note outside any pedal span unchanged', () => {
  const note = { startQL: 10, durationQL: 1 };
  const pedalEvents = [{ onQL: 1, offQL: 5 }];
  assert.strictEqual(effectiveDurationQL(note, pedalEvents), 1);
});

test('effectiveDurationQL keeps the note\'s own duration when it already exceeds the pedal-implied duration', () => {
  const note = { startQL: 2, durationQL: 10 };
  const pedalEvents = [{ onQL: 1, offQL: 5 }]; // pedal-implied duration would be 5 - 2 = 3
  assert.strictEqual(effectiveDurationQL(note, pedalEvents), 10);
});

test('ticksForFutureTime: a "when" equal to now maps to the current tick', () => {
  assert.strictEqual(ticksForFutureTime(1000, 1000, 5.0, 5.0), 1000);
});

test('ticksForFutureTime: 0.5s in the future at 1000 ticks/sec adds 500 ticks', () => {
  assert.strictEqual(ticksForFutureTime(1000, 1000, 5.0, 5.5), 1500);
});

test('ticksForFutureTime: scales correctly at a different ticksPerSecond', () => {
  assert.strictEqual(ticksForFutureTime(0, 500, 0.0, 2.0), 1000);
});

test('ticksForFutureTime: rounds to the nearest integer tick', () => {
  assert.strictEqual(ticksForFutureTime(0, 1000, 0.0, 0.0011), 1);
});
