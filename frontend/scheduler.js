class TempoClock {
  constructor(bpm) {
    this.bpm = bpm;
    this.referenceRealTime = 0;
    this.referenceOffsetQL = 0;
  }

  reset(realTime, offsetQL) {
    this.referenceRealTime = realTime;
    this.referenceOffsetQL = offsetQL;
  }

  setBpm(newBpm, realTimeNow) {
    const currentOffsetQL = this.offsetAt(realTimeNow);
    this.bpm = newBpm;
    this.reset(realTimeNow, currentOffsetQL);
  }

  secondsPerBeat() {
    return 60 / this.bpm;
  }

  timeAt(offsetQL) {
    return this.referenceRealTime + (offsetQL - this.referenceOffsetQL) * this.secondsPerBeat();
  }

  offsetAt(realTime) {
    return this.referenceOffsetQL + (realTime - this.referenceRealTime) / this.secondsPerBeat();
  }
}

function computeMeasureStarts(beats) {
  const starts = [];
  let lastMeasure = null;
  for (const b of beats) {
    if (b.measure !== lastMeasure) {
      starts.push({ offsetQL: b.offsetQL, measure: b.measure });
      lastMeasure = b.measure;
    }
  }
  return starts;
}

function snapLoopStart(offsetQL, measureStarts) {
  let result = measureStarts.length ? measureStarts[0].offsetQL : 0;
  for (const m of measureStarts) {
    if (m.offsetQL <= offsetQL) {
      result = m.offsetQL;
    } else {
      break;
    }
  }
  return result;
}

function snapLoopEnd(offsetQL, measureStarts, totalQuarterLength) {
  const start = snapLoopStart(offsetQL, measureStarts);
  for (const m of measureStarts) {
    if (m.offsetQL > start) {
      return m.offsetQL;
    }
  }
  return totalQuarterLength;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TempoClock, computeMeasureStarts, snapLoopStart, snapLoopEnd };
}
