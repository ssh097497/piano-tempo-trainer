from dataclasses import dataclass, field
from typing import List, Optional

import music21 as m21

DEFAULT_VELOCITY = 64


@dataclass
class NoteEvent:
    pitch: int
    start_ql: float
    duration_ql: float
    velocity: int


@dataclass
class PedalEvent:
    on_ql: float
    off_ql: float


@dataclass
class BeatEvent:
    offset_ql: float
    measure: int


@dataclass
class ScoreData:
    title: str
    time_signature_numerator: int
    time_signature_denominator: int
    total_quarter_length: float
    notes: List[NoteEvent] = field(default_factory=list)
    pedal_events: List[PedalEvent] = field(default_factory=list)
    beats: List[BeatEvent] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


def _abs_offset(note, score) -> Optional[float]:
    """Walk the site chain up to the enclosing Measure and add offsets,
    instead of calling note.getOffsetInHierarchy(score) directly — that
    call fails for notes reached through a PedalMark spanner when the note
    sits inside a Voice, or when the spanner's element is orphaned
    (activeSite is None). Returns None if no Measure is found within 10
    hops or the site chain is broken."""
    total = 0.0
    current = note
    for _ in range(10):
        site = current.activeSite
        if site is None:
            return None
        try:
            off = current.getOffsetBySite(site)
        except Exception:
            return None
        total += off
        if isinstance(site, m21.stream.Measure):
            return site.getOffsetInHierarchy(score) + total
        current = site
    return None


def extract_score_data(score: m21.stream.Score) -> ScoreData:
    warnings: List[str] = []

    title = "Untitled"
    if score.metadata and score.metadata.title:
        title = score.metadata.title

    ts = score.recurse().getElementsByClass('TimeSignature').first()
    if ts is None:
        numerator, denominator = 4, 4
        warnings.append("박자표를 찾을 수 없어서 4/4로 가정했어요.")
    else:
        numerator, denominator = ts.numerator, ts.denominator

    total_ql = float(score.duration.quarterLength)

    # NOTE: the pedal-span walk (_abs_offset) must run BEFORE any
    # part.flatten() call below. Calling .flatten() on a stream has the
    # side effect of rewriting each contained element's activeSite to
    # point at the (temporary) flattened stream instead of its original
    # Measure. That corrupts the site-chain that _abs_offset walks to
    # recover absolute offsets for notes reached through a PedalMark
    # spanner, silently turning every pedal event into a skipped one.
    # Doing this walk first, while activeSite still points at the
    # original Measure/Part/Score hierarchy, avoids the corruption.
    pedal_events: List[PedalEvent] = []
    skipped_pedals = 0
    for pm in score.recurse().getElementsByClass('PedalMark'):
        first, last = pm.getFirst(), pm.getLast()
        if first is None or last is None:
            skipped_pedals += 1
            continue
        on_ql = _abs_offset(first, score)
        off_ql = _abs_offset(last, score)
        if on_ql is None or off_ql is None:
            skipped_pedals += 1
            continue
        off_ql = off_ql + float(last.duration.quarterLength)
        pedal_events.append(PedalEvent(on_ql=on_ql, off_ql=off_ql))
    pedal_events.sort(key=lambda e: e.on_ql)
    if skipped_pedals:
        warnings.append(f"페달 지시 {skipped_pedals}개를 위치 정보 부족으로 건너뜀")

    notes: List[NoteEvent] = []
    for part in score.parts:
        for n in part.flatten().notesAndRests:
            if n.isRest:
                continue
            velocity = n.volume.velocity
            if velocity is None:
                velocity = DEFAULT_VELOCITY
            pitches = n.pitches if hasattr(n, 'pitches') else [n.pitch]
            for p in pitches:
                notes.append(NoteEvent(
                    pitch=int(p.midi),
                    start_ql=float(n.offset),
                    duration_ql=float(n.duration.quarterLength),
                    velocity=int(velocity),
                ))

    beats: List[BeatEvent] = []
    part0 = score.parts[0]
    for measure in part0.getElementsByClass('Measure'):
        m_offset = measure.getOffsetInHierarchy(score)
        measure_ts = measure.timeSignature or ts
        beats_in_measure = measure_ts.numerator if measure_ts else numerator
        for b in range(beats_in_measure):
            beats.append(BeatEvent(offset_ql=m_offset + b, measure=measure.number))

    return ScoreData(
        title=title,
        time_signature_numerator=numerator,
        time_signature_denominator=denominator,
        total_quarter_length=total_ql,
        notes=notes,
        pedal_events=pedal_events,
        beats=beats,
        warnings=warnings,
    )


def parse_score_file(path: str) -> ScoreData:
    score = m21.converter.parse(path)
    return extract_score_data(score)


def to_json_dict(score_data: ScoreData) -> dict:
    return {
        "title": score_data.title,
        "timeSignature": {
            "numerator": score_data.time_signature_numerator,
            "denominator": score_data.time_signature_denominator,
        },
        "totalQuarterLength": score_data.total_quarter_length,
        "notes": [
            {"pitch": n.pitch, "startQL": n.start_ql, "durationQL": n.duration_ql, "velocity": n.velocity}
            for n in score_data.notes
        ],
        "pedalEvents": [
            {"onQL": p.on_ql, "offQL": p.off_ql} for p in score_data.pedal_events
        ],
        "beats": [
            {"offsetQL": b.offset_ql, "measure": b.measure} for b in score_data.beats
        ],
        "warnings": score_data.warnings,
    }
