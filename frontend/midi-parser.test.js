const test = require('node:test');
const assert = require('node:assert');
const { parseMidi } = require('./midi-parser.js');

function encodeVLQ(value) {
  const bytes = [value & 0x7f];
  value = value >> 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value = value >> 7;
  }
  return bytes;
}

function buildTestMidi() {
  const trackEvents = [];
  // Time signature 3/4 at tick 0 (meta type 0x58: numerator, denom-as-power-of-2, clocks/click, 32nds/quarter)
  trackEvents.push(...encodeVLQ(0), 0xff, 0x58, 0x04, 3, 2, 24, 8);
  // Note On pitch 60 velocity 80 at tick 0
  trackEvents.push(...encodeVLQ(0), 0x90, 60, 80);
  // Note Off pitch 60 at tick 480 (one quarter note later, division = 480)
  trackEvents.push(...encodeVLQ(480), 0x80, 60, 0);
  // Note On pitch 64 velocity 80 at the same tick (delta 0)
  trackEvents.push(...encodeVLQ(0), 0x90, 64, 80);
  // Note Off pitch 64 at tick 960
  trackEvents.push(...encodeVLQ(480), 0x80, 64, 0);
  // End of track
  trackEvents.push(...encodeVLQ(0), 0xff, 0x2f, 0x00);

  const trackLength = trackEvents.length;
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length 6
    0x00, 0x00,             // format 0
    0x00, 0x01,             // 1 track
    0x01, 0xe0,             // division = 480
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (trackLength >> 24) & 0xff, (trackLength >> 16) & 0xff, (trackLength >> 8) & 0xff, trackLength & 0xff,
    ...trackEvents,
  ];
  return new Uint8Array(bytes).buffer;
}

test('parseMidi reads ticksPerQuarter from the header division field', () => {
  const result = parseMidi(buildTestMidi());
  assert.strictEqual(result.ticksPerQuarter, 480);
});

test('parseMidi decodes the time signature meta event', () => {
  const result = parseMidi(buildTestMidi());
  const ts = result.tracks[0].find((e) => e.type === 'timeSignature');
  assert.ok(ts, 'expected a timeSignature event');
  assert.strictEqual(ts.ticks, 0);
  assert.strictEqual(ts.numerator, 3);
  assert.strictEqual(ts.denominator, 4);
});

test('parseMidi extracts noteOn/noteOff pairs at correct absolute tick positions', () => {
  const result = parseMidi(buildTestMidi());
  const notes = result.tracks[0]
    .filter((e) => e.type === 'noteOn' || e.type === 'noteOff')
    .map((e) => [e.type, e.ticks, e.note]);
  assert.deepStrictEqual(notes, [
    ['noteOn', 0, 60],
    ['noteOff', 480, 60],
    ['noteOn', 480, 64],
    ['noteOff', 960, 64],
  ]);
});

test('parseMidi includes an endOfTrack event at the final tick', () => {
  const result = parseMidi(buildTestMidi());
  const eot = result.tracks[0].find((e) => e.type === 'endOfTrack');
  assert.ok(eot);
  assert.strictEqual(eot.ticks, 960);
});

function buildMidiWithRunningStatus() {
  const trackEvents = [];
  // Note On pitch 60 velocity 80 at tick 0 (explicit status byte 0x90)
  trackEvents.push(...encodeVLQ(0), 0x90, 60, 80);
  // Note On pitch 64 velocity 90 at tick 240 (OMIT status byte, rely on running status)
  trackEvents.push(...encodeVLQ(240), 64, 90);
  // Note Off pitch 60 at tick 480 (new status 0x80, changes running status)
  trackEvents.push(...encodeVLQ(240), 0x80, 60, 0);
  // Note Off pitch 64 at tick 720 (OMIT status byte, use running status 0x80)
  trackEvents.push(...encodeVLQ(240), 64, 0);
  // End of track
  trackEvents.push(...encodeVLQ(0), 0xff, 0x2f, 0x00);

  const trackLength = trackEvents.length;
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length 6
    0x00, 0x00,             // format 0
    0x00, 0x01,             // 1 track
    0x01, 0xe0,             // division = 480
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (trackLength >> 24) & 0xff, (trackLength >> 16) & 0xff, (trackLength >> 8) & 0xff, trackLength & 0xff,
    ...trackEvents,
  ];
  return new Uint8Array(bytes).buffer;
}

test('parseMidi correctly handles running status (omitted status bytes)', () => {
  const result = parseMidi(buildMidiWithRunningStatus());
  const notes = result.tracks[0]
    .filter((e) => e.type === 'noteOn' || e.type === 'noteOff')
    .map((e) => [e.type, e.ticks, e.note, e.velocity !== undefined ? e.velocity : null]);
  assert.deepStrictEqual(notes, [
    ['noteOn', 0, 60, 80],        // explicit 0x90
    ['noteOn', 240, 64, 90],      // running status 0x90 (no explicit status byte)
    ['noteOff', 480, 60, null],   // new explicit 0x80
    ['noteOff', 720, 64, null],   // running status 0x80 (no explicit status byte)
  ]);
});
