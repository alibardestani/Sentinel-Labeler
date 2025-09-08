# services/progress.py
from __future__ import annotations
from dataclasses import dataclass, asdict
from pathlib import Path
import json
import threading
import time

from config import settings

_PROGRESS_FILE: Path = settings.OUTPUT_DIR / "progress.json"
_LOCK = threading.Lock()

@dataclass
class _State:
    phase: str = "idle"
    percent: float = 0.0
    note: str = ""
    ts: float = 0.0  # unix time

def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)

def _read_state() -> _State:
    try:
        j = json.loads(_PROGRESS_FILE.read_text(encoding="utf-8"))
        return _State(
            phase=str(j.get("phase", "idle")),
            percent=float(j.get("percent", 0.0)),
            note=str(j.get("note", "")),
            ts=float(j.get("ts", 0.0)),
        )
    except Exception:
        return _State()

def reset() -> None:
    with _LOCK:
        st = _State(phase="idle", percent=0.0, note="", ts=time.time())
        _atomic_write(_PROGRESS_FILE, asdict(st))

def set_progress(phase: str, percent: float, note: str | None = None) -> None:
    with _LOCK:
        st = _read_state()
        st.phase = str(phase)
        try:
            p = float(percent)
        except Exception:
            p = 0.0
        st.percent = max(0.0, min(100.0, p))
        if note is not None:
            st.note = str(note)
        st.ts = time.time()
        _atomic_write(_PROGRESS_FILE, asdict(st))

def get_progress() -> dict:
    st = _read_state()
    return {
        "phase": st.phase,
        "percent": st.percent,
        "note": st.note,
        "ts": st.ts,
    }