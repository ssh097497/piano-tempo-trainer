const test = require('node:test');
const assert = require('node:assert');
const { computeTimeSignatureAndPedalSpans } = require('./xml-score-reader.js');

test('computeTimeSignatureAndPedalSpans finds the time signature from the first measure that declares one', () => {
  const measures = [
    { number: 1, divisions: 2, timeSignature: { numerator: 3, denominator: 4 }, positionEvents: [{ advance: 6 }] },
    { number: 2, divisions: 2, timeSignature: null, positionEvents: [{ advance: 6 }] },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.timeSignature, { numerator: 3, denominator: 4 });
  assert.deepStrictEqual(result.warnings, []);
});

test('computeTimeSignatureAndPedalSpans falls back to 4/4 with a warning if no measure declares a time signature', () => {
  const measures = [{ number: 1, divisions: 1, timeSignature: null, positionEvents: [{ advance: 4 }] }];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.timeSignature, { numerator: 4, denominator: 4 });
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('박자표'));
});

test('computeTimeSignatureAndPedalSpans pairs a pedal start/stop within one measure into a quarterLength span', () => {
  // divisions=2 means 2 divisions per quarter note. Measure has: advance 2 (1 QL), pedal start,
  // advance 2 (1 QL), pedal stop, advance 2 (1 QL) -- so pedal starts at QL 1.0, stops at QL 2.0.
  const measures = [
    {
      number: 1,
      divisions: 2,
      timeSignature: { numerator: 3, denominator: 4 },
      positionEvents: [{ advance: 2 }, { pedal: 'start' }, { advance: 2 }, { pedal: 'stop' }, { advance: 2 }],
    },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.pedalEvents, [{ onQL: 1.0, offQL: 2.0 }]);
});

test('computeTimeSignatureAndPedalSpans converts measure-local divisions into absolute quarterLength across measures', () => {
  // Measure 1 is 3 QL long (divisions=2, total advance=6 -> 3.0 QL). Measure 2's pedal start at
  // local position 2 divisions (1.0 QL) must land at absolute QL 3.0 + 1.0 = 4.0.
  const measures = [
    { number: 1, divisions: 2, timeSignature: { numerator: 3, denominator: 4 }, positionEvents: [{ advance: 6 }] },
    {
      number: 2,
      divisions: 2,
      timeSignature: null,
      positionEvents: [{ advance: 2 }, { pedal: 'start' }, { advance: 2 }, { pedal: 'stop' }, { advance: 2 }],
    },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.pedalEvents, [{ onQL: 4.0, offQL: 5.0 }]);
});

test('computeTimeSignatureAndPedalSpans warns and skips an unmatched pedal stop with no preceding start', () => {
  const measures = [
    { number: 1, divisions: 2, timeSignature: { numerator: 3, denominator: 4 }, positionEvents: [{ pedal: 'stop' }, { advance: 6 }] },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.pedalEvents, []);
  assert.strictEqual(result.warnings.length, 1);
});
