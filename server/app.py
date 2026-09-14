import os
import tempfile

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles

from server.score_parser import parse_score_file, to_json_dict

ALLOWED_EXTENSIONS = {".musicxml", ".mxl", ".xml"}

app = FastAPI()


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/parse")
async def parse_endpoint(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="MusicXML(.musicxml/.mxl) 파일만 지원해요")

    data = await file.read()
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        score_data = parse_score_file(tmp_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"악보 파싱에 실패했어요: {exc}")
    finally:
        os.unlink(tmp_path)

    return to_json_dict(score_data)


_FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.isdir(_FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=_FRONTEND_DIR, html=True), name="frontend")
