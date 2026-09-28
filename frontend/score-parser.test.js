const test = require('node:test');
const assert = require('node:assert');
const { assignHands } = require('./score-parser.js');

test('assignHands labels the first of exactly two note-bearing tracks "right" and the second "left"', () => {
  const rightHandNote = { pitch: 80, startQL: 0, durationQL: 1, velocity: 90 };
  const leftHandNote = { pitch: 48, startQL: 0.5, durationQL: 1, velocity: 80 };
  const result = assignHands([[rightHandNote], [leftHandNote]]);
  assert.strictEqual(result.handSeparationAvailable, true);
  assert.deepStrictEqual(result.notes.map((n) => n.hand), ['right', 'left']);
});

test('assignHands ignores tracks with no notes (e.g. a meta/tempo track) when counting note-bearing tracks', () => {
  const metaTrack = [];
  const rightHandNote = { pitch: 80, startQL: 0, durationQL: 1, velocity: 90 };
  const leftHandNote = { pitch: 48, startQL: 0, durationQL: 1, velocity: 80 };
  const result = assignHands([metaTrack, [rightHandNote], [leftHandNote]]);
  assert.strictEqual(result.handSeparationAvailable, true);
  assert.deepStrictEqual(result.notes.map((n) => n.hand).sort(), ['left', 'right']);
});

test('assignHands marks separation unavailable (hand: null on every note) when there is only one note-bearing track', () => {
  const onlyMelodyTrack = [
    { pitch: 72, startQL: 0, durationQL: 1, velocity: 90 },
    { pitch: 74, startQL: 1, durationQL: 1, velocity: 90 },
  ];
  const result = assignHands([onlyMelodyTrack]);
  assert.strictEqual(result.handSeparationAvailable, false);
  assert.deepStrictEqual(result.notes.map((n) => n.hand), [null, null]);
});

test('assignHands marks separation unavailable when there are three or more note-bearing tracks', () => {
  const trackA = [{ pitch: 80, startQL: 0, durationQL: 1, velocity: 90 }];
  const trackB = [{ pitch: 60, startQL: 0, durationQL: 1, velocity: 90 }];
  const trackC = [{ pitch: 40, startQL: 0, durationQL: 1, velocity: 90 }];
  const result = assignHands([trackA, trackB, trackC]);
  assert.strictEqual(result.handSeparationAvailable, false);
  assert.deepStrictEqual(result.notes.map((n) => n.hand), [null, null, null]);
});

test('assignHands sorts the merged notes by startQL across both hands', () => {
  const rightHand = [
    { pitch: 80, startQL: 1, durationQL: 1, velocity: 90 },
    { pitch: 81, startQL: 3, durationQL: 1, velocity: 90 },
  ];
  const leftHand = [{ pitch: 40, startQL: 2, durationQL: 1, velocity: 90 }];
  const result = assignHands([rightHand, leftHand]);
  assert.deepStrictEqual(
    result.notes.map((n) => n.startQL),
    [1, 2, 3]
  );
});
