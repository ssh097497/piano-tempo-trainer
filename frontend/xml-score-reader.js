function computeTimeSignatureAndPedalSpans(measures) {
  const warnings = [];
  let timeSignature = null;
  for (const measure of measures) {
    if (measure.timeSignature) {
      timeSignature = measure.timeSignature;
      break;
    }
  }
  if (!timeSignature) {
    timeSignature = { numerator: 4, denominator: 4 };
    warnings.push('박자표를 찾을 수 없어서 4/4로 가정했어요.');
  }

  const pedalEvents = [];
  let measureStartQL = 0;
  let openPedalStartQL = null;

  for (const measure of measures) {
    const divisions = measure.divisions || 1;
    let localDivisions = 0;
    for (const event of measure.positionEvents) {
      if ('advance' in event) {
        localDivisions += event.advance;
        continue;
      }
      const currentQL = measureStartQL + localDivisions / divisions;
      if (event.pedal === 'start') {
        if (openPedalStartQL !== null) {
          warnings.push('이전 페달이 안 닫힌 채로 새 페달이 시작돼서, 이전 페달은 건너뜀.');
        }
        openPedalStartQL = currentQL;
      } else if (event.pedal === 'stop') {
        if (openPedalStartQL === null) {
          warnings.push('시작 없이 끝나는 페달 지시를 건너뜀.');
        } else {
          pedalEvents.push({ onQL: openPedalStartQL, offQL: currentQL });
          openPedalStartQL = null;
        }
      }
    }
    // A measure's total duration in quarterLength, for advancing to the next measure's start.
    let measureTotalDivisions = 0;
    for (const event of measure.positionEvents) {
      if ('advance' in event) measureTotalDivisions += event.advance;
    }
    measureStartQL += measureTotalDivisions / divisions;
  }

  return { timeSignature, pedalEvents, warnings };
}

function extractMeasuresFromDocument(xmlDocument) {
  const measures = [];
  let currentDivisions = 1;
  const measureNodes = xmlDocument.querySelectorAll('part:first-of-type > measure');
  for (const measureNode of measureNodes) {
    const number = parseInt(measureNode.getAttribute('number'), 10);
    let timeSignature = null;
    const divisionsNode = measureNode.querySelector('attributes > divisions');
    if (divisionsNode) currentDivisions = parseInt(divisionsNode.textContent, 10);
    const timeNode = measureNode.querySelector('attributes > time');
    if (timeNode) {
      const beats = timeNode.querySelector('beats');
      const beatType = timeNode.querySelector('beat-type');
      if (beats && beatType) {
        timeSignature = { numerator: parseInt(beats.textContent, 10), denominator: parseInt(beatType.textContent, 10) };
      }
    }

    const positionEvents = [];
    for (const child of measureNode.children) {
      if (child.tagName === 'note') {
        const isChord = !!child.querySelector('chord');
        const isGrace = !!child.querySelector('grace');
        const durationNode = child.querySelector('duration');
        const duration = durationNode ? parseInt(durationNode.textContent, 10) : 0;
        if (!isChord && !isGrace) positionEvents.push({ advance: duration });
      } else if (child.tagName === 'backup') {
        const duration = parseInt(child.querySelector('duration').textContent, 10);
        positionEvents.push({ advance: -duration });
      } else if (child.tagName === 'forward') {
        const duration = parseInt(child.querySelector('duration').textContent, 10);
        positionEvents.push({ advance: duration });
      } else if (child.tagName === 'direction') {
        const pedalNode = child.querySelector('pedal');
        if (pedalNode) {
          const pedalType = pedalNode.getAttribute('type');
          if (pedalType === 'start') positionEvents.push({ pedal: 'start' });
          else if (pedalType === 'stop') positionEvents.push({ pedal: 'stop' });
        }
      }
    }

    measures.push({ number, divisions: currentDivisions, timeSignature, positionEvents });
  }
  return measures;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeTimeSignatureAndPedalSpans, extractMeasuresFromDocument };
}
