function parseVLQ(bytes, offset) {
  let value = 0;
  let pos = offset;
  for (;;) {
    const byte = bytes[pos];
    value = (value << 7) | (byte & 0x7f);
    pos++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, nextOffset: pos };
}

function parseMidi(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let offset = 0;

  function readUint32() {
    const v = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    offset += 4;
    return v;
  }
  function readUint16() {
    const v = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    return v;
  }
  function readAscii(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
    offset += len;
    return s;
  }

  if (readAscii(4) !== 'MThd') throw new Error('Not a valid MIDI file: missing MThd header');
  readUint32(); // header length, always 6, not needed
  readUint16(); // format, not needed
  const numTracks = readUint16();
  const division = readUint16();
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  const ticksPerQuarter = division;

  const tracks = [];
  for (let t = 0; t < numTracks; t++) {
    if (readAscii(4) !== 'MTrk') throw new Error('Expected MTrk chunk');
    const trackLength = readUint32();
    const trackEnd = offset + trackLength;
    const events = [];
    let absoluteTicks = 0;
    let runningStatus = null;

    while (offset < trackEnd) {
      const deltaResult = parseVLQ(bytes, offset);
      absoluteTicks += deltaResult.value;
      offset = deltaResult.nextOffset;

      let statusByte = bytes[offset];
      if (statusByte < 0x80) {
        statusByte = runningStatus; // running status: reuse previous, don't consume a byte
      } else {
        offset++;
        runningStatus = statusByte;
      }

      if (statusByte === 0xff) {
        const metaType = bytes[offset];
        offset++;
        const lenResult = parseVLQ(bytes, offset);
        offset = lenResult.nextOffset;
        const data = bytes.slice(offset, offset + lenResult.value);
        offset += lenResult.value;
        if (metaType === 0x58 && data.length >= 4) {
          events.push({
            ticks: absoluteTicks,
            type: 'timeSignature',
            numerator: data[0],
            denominator: Math.pow(2, data[1]),
          });
        } else if (metaType === 0x2f) {
          events.push({ ticks: absoluteTicks, type: 'endOfTrack' });
        }
        // Other meta types (tempo, key signature, text, ...) are intentionally not emitted.
      } else if (statusByte === 0xf0 || statusByte === 0xf7) {
        const lenResult = parseVLQ(bytes, offset);
        offset = lenResult.nextOffset + lenResult.value; // skip sysex payload
      } else if (statusByte >= 0xf1 && statusByte <= 0xf6) {
        // System-common messages: MTC (0xF1), Song Position (0xF2), Song Select (0xF3), undefined (0xF4/0xF5), Tune Request (0xF6)
        // These are almost never found in standard MIDI files (they're for live performance/transport control).
        // Fail loudly rather than silently mis-parsing and corrupting the track.
        throw new Error(`Unsupported system-common byte 0x${statusByte.toString(16).toUpperCase()} at offset ${offset - 1} — these bytes are not typically found in Standard MIDI Files`);
      } else if (statusByte >= 0xf8) {
        // System realtime messages (0xF8-0xFE) and reset (0xFF already handled above as meta).
        // These are also almost never in Standard MIDI Files (used for live performance timing/synchronization).
        // Fail loudly rather than silently mis-parsing.
        throw new Error(`Unsupported system-realtime byte 0x${statusByte.toString(16).toUpperCase()} at offset ${offset - 1} — these bytes are not typically found in Standard MIDI Files`);
      } else {
        const eventType = statusByte & 0xf0;
        const channel = statusByte & 0x0f;
        if (eventType === 0xc0 || eventType === 0xd0) {
          offset += 1; // program change / channel pressure: 1 data byte
        } else {
          const d1 = bytes[offset];
          const d2 = bytes[offset + 1];
          offset += 2;
          if (eventType === 0x90 && d2 > 0) {
            events.push({ ticks: absoluteTicks, type: 'noteOn', channel, note: d1, velocity: d2 });
          } else if (eventType === 0x80 || (eventType === 0x90 && d2 === 0)) {
            events.push({ ticks: absoluteTicks, type: 'noteOff', channel, note: d1 });
          } else if (eventType === 0xb0) {
            events.push({ ticks: absoluteTicks, type: 'controlChange', channel, controller: d1, value: d2 });
          }
          // 0xa0 (poly aftertouch) and 0xe0 (pitch bend) bytes are consumed above but not emitted.
        }
      }
    }
    tracks.push(events);
    offset = trackEnd;
  }

  return { ticksPerQuarter, tracks };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMidi };
}
