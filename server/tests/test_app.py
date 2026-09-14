import io

from fastapi.testclient import TestClient

from server.app import app

client = TestClient(app)


VALID_MUSICXML = b"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>3</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""


def test_rejects_unsupported_extension():
    response = client.post(
        "/api/parse",
        files={"file": ("song.pdf", io.BytesIO(b"not a score"), "application/pdf")},
    )
    assert response.status_code == 400
    assert "MusicXML" in response.json()["detail"]


def test_rejects_unparseable_musicxml():
    response = client.post(
        "/api/parse",
        files={"file": ("song.musicxml", io.BytesIO(b"not valid xml at all"), "application/xml")},
    )
    assert response.status_code == 400
    assert "파싱" in response.json()["detail"]


def test_accepts_valid_musicxml():
    response = client.post(
        "/api/parse",
        files={"file": ("song.musicxml", io.BytesIO(VALID_MUSICXML), "application/xml")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["timeSignature"] == {"numerator": 3, "denominator": 4}
    assert len(body["notes"]) == 1
