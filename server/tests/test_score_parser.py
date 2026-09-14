import music21 as m21
from server.score_parser import extract_score_data, to_json_dict


def build_test_score():
    """A tiny synthetic 3/4 score: 2 measures, one pedal span across the
    barline, and a rest, to exercise the same code paths as the real
    Moszkowski file without depending on a checked-in copyrighted score."""
    part = m21.stream.Part()
    part.append(m21.meter.TimeSignature('3/4'))

    m1 = m21.stream.Measure(number=1)
    n1 = m21.note.Note('C4', quarterLength=1.0)
    n1.volume.velocity = 80
    n2 = m21.note.Note('E4', quarterLength=1.0)
    n2.volume.velocity = 80
    n3 = m21.note.Rest(quarterLength=1.0)
    m1.append([n1, n2, n3])

    m2 = m21.stream.Measure(number=2)
    n4 = m21.note.Note('G4', quarterLength=3.0)
    m2.append(n4)

    part.append([m1, m2])
    score = m21.stream.Score()
    score.metadata = m21.metadata.Metadata(title="Test Piece")
    score.insert(0, part)

    pedal = m21.expressions.PedalMark()
    pedal.addSpannedElements([n2, n4])
    part.insert(0, pedal)

    return score


def test_extracts_time_signature():
    data = extract_score_data(build_test_score())
    assert data.time_signature_numerator == 3
    assert data.time_signature_denominator == 4


def test_extracts_notes_skips_rests():
    data = extract_score_data(build_test_score())
    # 3 real notes (C4, E4, G4); the Rest is excluded
    assert len(data.notes) == 3
    pitches = sorted(n.pitch for n in data.notes)
    assert pitches == [60, 64, 67]  # C4, E4, G4 as MIDI numbers


def test_note_velocity_and_default():
    data = extract_score_data(build_test_score())
    by_pitch = {n.pitch: n for n in data.notes}
    assert by_pitch[64].velocity == 80  # E4, explicit velocity
    assert by_pitch[67].velocity == 64  # G4, no explicit velocity -> default


def test_pedal_span_recovered_across_barline():
    data = extract_score_data(build_test_score())
    assert len(data.pedal_events) == 1
    pedal = data.pedal_events[0]
    assert pedal.on_ql == 1.0   # E4 starts at beat 2 of measure 1 -> offset 1.0
    assert pedal.off_ql == 6.0  # G4 starts at offset 3.0, duration 3.0 -> ends at 6.0


def test_beats_cover_both_measures_in_3_4():
    data = extract_score_data(build_test_score())
    offsets = [b.offset_ql for b in data.beats]
    assert offsets == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]


def test_missing_time_signature_falls_back_to_4_4_with_warning():
    part = m21.stream.Part()
    m1 = m21.stream.Measure(number=1)
    m1.append(m21.note.Note('C4', quarterLength=4.0))
    part.append(m1)
    score = m21.stream.Score()
    score.insert(0, part)

    data = extract_score_data(score)
    assert data.time_signature_numerator == 4
    assert data.time_signature_denominator == 4
    assert any("박자표" in w for w in data.warnings)


def test_to_json_dict_uses_camel_case_keys():
    data = extract_score_data(build_test_score())
    payload = to_json_dict(data)
    assert payload["timeSignature"] == {"numerator": 3, "denominator": 4}
    assert "totalQuarterLength" in payload
    note = payload["notes"][0]
    assert set(note.keys()) == {"pitch", "startQL", "durationQL", "velocity"}
    pedal = payload["pedalEvents"][0]
    assert set(pedal.keys()) == {"onQL", "offQL"}
    beat = payload["beats"][0]
    assert set(beat.keys()) == {"offsetQL", "measure"}
