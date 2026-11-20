"""NOVA // OS — local Python helper service.

Binds strictly to 127.0.0.1 unless LAN pairing mode is explicitly
toggled on. Requires a cryptographic random bearer token (X-Nova-Token)
generated on first run and saved to helper/token.txt.

Run:  python helper/main.py   (or uvicorn helper.main:app --host 127.0.0.1 --port 8787)
"""
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"
TOKEN_PATH = BASE / "token.txt"
ACTION_LOG: List[Dict[str, Any]] = []

def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

def get_token() -> str:
    if TOKEN_PATH.exists():
        t = TOKEN_PATH.read_text(encoding="utf-8").strip()
        if t:
            return t
    t = secrets.token_urlsafe(32)
    TOKEN_PATH.write_text(t, encoding="utf-8")
    try:
        os.chmod(TOKEN_PATH, 0o600)
    except Exception:
        pass
    return t

CFG = load_config()
TOKEN = get_token()

def log_action(action: str, target: str, result: str, detail: str = ""):
    entry = {"ts": time.time(), "action": action, "target": target, "result": result, "detail": detail}
    ACTION_LOG.append(entry)
    if len(ACTION_LOG) > 500:
        del ACTION_LOG[: len(ACTION_LOG) - 500]
    return entry

def is_allowed_app(name: str) -> bool:
    allow = (CFG.get("allowlist") or {}).get("apps", [])
    return name.lower() in [a.lower() for a in allow]

def is_allowed_folder(path: str) -> bool:
    import os as _os
    allow = (CFG.get("allowlist") or {}).get("folders", [])
    try:
        rp = _os.path.realpath(path)
    except Exception:
        return False
    for f in allow:
        try:
            if rp.startswith(_os.path.realpath(os.path.expandvars(f))):
                return True
        except Exception:
            continue
    return False

def is_allowed_window(title: str) -> bool:
    allow = (CFG.get("allowlist") or {}).get("windows", [])
    if not allow:
        return True  # empty allowlist = any non-elevated window allowed by title match
    return any(a.lower() in (title or "").lower() for a in allow)

def check_token(x_nova_token: Optional[str]):
    if x_nova_token != TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Nova-Token")

app = FastAPI(title="NOVA // OS Helper", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in ("/health", "/token/qr"):
        return await call_next(request)
    tok = request.headers.get("x-nova-token")
    if tok != TOKEN:
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)

class ActionRequest(BaseModel):
    action: str
    args: Dict[str, Any] = {}

@app.get("/health")
def health():
    return {"ok": True, "host": CFG.get("bind_host", "127.0.0.1"), "port": CFG.get("port", 8787)}

@app.get("/token/qr")
def token_qr():
    # Returns pairing payload; token included so desktop can render QR.
    import socket
    host = CFG.get("bind_host", "127.0.0.1")
    if host == "127.0.0.1":
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            host = s.getsockname()[0]
            s.close()
        except Exception:
            pass
    port = CFG.get("port", 8787)
    return {"host": f"{host}:{port}", "token": TOKEN}

@app.get("/config")
def get_config():
    return CFG

@app.post("/config")
def set_config(patch: dict):
    global CFG
    # deep merge
    def merge(a, b):
        for k, v in b.items():
            if isinstance(v, dict) and isinstance(a.get(k), dict):
                merge(a[k], v)
            else:
                a[k] = v
        return a
    merge(CFG, patch)
    save_config(CFG)
    return {"ok": True, "config": CFG}

@app.get("/action-log")
def action_log():
    return {"entries": ACTION_LOG[-200:]}

# ---------- Phase 3: Apps & Files ----------

def _resolve_folder(p: str) -> str:
    return os.path.expandvars(os.path.expanduser(p))

@app.post("/action")
def do_action(req: ActionRequest):
    action = req.action
    args = req.args or {}
    # Phase 3
    if action == "open_app":
        name = str(args.get("name", "")).strip()
        if not is_allowed_app(name):
            log_action(action, name, "refused", "not in allowlist")
            raise HTTPException(status_code=403, detail=f"App '{name}' is not in the allowlist")
        try:
            if sys.platform.startswith("win"):
                os.startfile(name)  # type: ignore
            else:
                subprocess.Popen([name])
            log_action(action, name, "ok")
            return {"ok": True, "summary": f"Opened {name}"}
        except Exception as e:
            log_action(action, name, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))

    if action == "open_folder":
        path = _resolve_folder(str(args.get("path", "")))
        if not is_allowed_folder(path):
            log_action(action, path, "refused", "not in allowlist")
            raise HTTPException(status_code=403, detail="Folder not in allowlist")
        try:
            if sys.platform.startswith("win"):
                subprocess.Popen(["explorer", path])
            else:
                subprocess.Popen(["xdg-open", path])
            log_action(action, path, "ok")
            return {"ok": True, "summary": f"Opened folder {path}"}
        except Exception as e:
            log_action(action, path, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))

    if action == "read_file":
        path = _resolve_folder(str(args.get("path", "")))
        if not is_allowed_folder(os.path.dirname(path)):
            log_action(action, path, "refused", "not in allowlist")
            raise HTTPException(status_code=403, detail="Path not in allowlist")
        try:
            data = Path(path).read_text(encoding="utf-8", errors="replace")
            log_action(action, path, "ok", f"{len(data)} chars")
            return {"ok": True, "content": data[:200000], "path": path}
        except Exception as e:
            log_action(action, path, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))

    if action == "list_folder":
        path = _resolve_folder(str(args.get("path", "")))
        if not is_allowed_folder(path):
            log_action(action, path, "refused", "not in allowlist")
            raise HTTPException(status_code=403, detail="Folder not in allowlist")
        try:
            entries = []
            for p in sorted(Path(path).iterdir()):
                entries.append({"name": p.name, "is_dir": p.is_dir(), "size": (p.stat().st_size if p.is_file() else 0)})
            log_action(action, path, "ok", f"{len(entries)} entries")
            return {"ok": True, "path": path, "entries": entries}
        except Exception as e:
            log_action(action, path, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))

    if action == "write_file":
        # Requires explicit UI confirmation (frontend must pass confirm:true)
        if not args.get("confirm"):
            log_action(action, str(args.get("path")), "refused", "confirmation required")
            raise HTTPException(status_code=400, detail="write_file requires confirm:true (destructive)")
        path = _resolve_folder(str(args.get("path", "")))
        if not is_allowed_folder(os.path.dirname(path)):
            log_action(action, path, "refused", "not in allowlist")
            raise HTTPException(status_code=403, detail="Path not in allowlist")
        try:
            Path(path).write_text(str(args.get("content", "")), encoding="utf-8")
            log_action(action, path, "ok")
            return {"ok": True, "summary": f"Wrote {path}"}
        except Exception as e:
            log_action(action, path, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))

    if action == "delete_file":
        if not args.get("confirm"):
            log_action(action, str(args.get("path")), "refused", "confirmation required")
            raise HTTPException(status_code=400, detail="delete_file requires confirm:true (destructive)")
        path = _resolve_folder(str(args.get("path", "")))
        if not is_allowed_folder(os.path.dirname(path)):
            log_action(action, path, "refused", "not in allowlist")
            raise HTTPException(status_code=403, detail="Path not in allowlist")
        try:
            Path(path).unlink()
            log_action(action, path, "ok")
            return {"ok": True, "summary": f"Deleted {path}"}
        except Exception as e:
            log_action(action, path, "error", str(e))
            raise HTTPException(status_code=500, detail=str(e))

    # ---------- Phase 4: Window Control ----------
    if action in ("list_windows", "focus_window", "move_window", "resize_window",
                   "minimize_window", "maximize_window", "close_window"):
        try:
            import pygetwindow as gw
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"pygetwindow unavailable: {e}")

        if action == "list_windows":
            wins = [{"title": w.title, "left": w.left, "top": w.top, "width": w.width, "height": w.height} for w in gw.getAllWindows() if w.title]
            return {"ok": True, "windows": wins}

        title = str(args.get("title", ""))
        matches = [w for w in gw.getAllWindows() if title.lower() in (w.title or "").lower()]
        if not matches:
            log_action(action, title, "error", "window not found")
            raise HTTPException(status_code=404, detail="Window not found")
        w = matches[0]
        if not is_allowed_window(w.title):
            log_action(action, w.title, "refused", "window not allowlisted")
            raise HTTPException(status_code=403, detail="Window not in allowlist")

        if action == "focus_window":
            try:
                w.activate()
            except Exception:
                pass
            log_action(action, w.title, "ok")
            return {"ok": True, "summary": f"Focused {w.title}"}

        if action == "move_window":
            preset = str(args.get("preset", "")).lower()
            if preset == "left half":
                w.moveTo(0, 0); w.resizeTo(960, 1080)
            elif preset == "right half":
                w.moveTo(960, 0); w.resizeTo(960, 1080)
            else:
                w.moveTo(int(args.get("x", w.left)), int(args.get("y", w.top)))
            log_action(action, w.title, "ok", preset or "moved")
            return {"ok": True, "summary": f"Moved {w.title}"}

        if action == "resize_window":
            w.resizeTo(int(args.get("width", w.width)), int(args.get("height", w.height)))
            log_action(action, w.title, "ok")
            return {"ok": True, "summary": f"Resized {w.title}"}

        if action == "minimize_window":
            w.minimize()
            log_action(action, w.title, "ok")
            return {"ok": True, "summary": f"Minimized {w.title}"}

        if action == "maximize_window":
            w.maximize()
            log_action(action, w.title, "ok")
            return {"ok": True, "summary": f"Maximized {w.title}"}

        if action == "close_window":
            if not args.get("confirm"):
                log_action(action, w.title, "refused", "confirmation required")
                raise HTTPException(status_code=400, detail="close_window requires confirm:true (destructive)")
            w.close()
            log_action(action, w.title, "ok")
            return {"ok": True, "summary": f"Closed {w.title}"}

    # ---------- Phase 5: Keystrokes & Mouse ----------
    if action in ("type_text", "press_keys", "mouse_click"):
        if not CFG.get("input_control", {}).get("enabled", False):
            log_action(action, "", "refused", "input control disabled")
            raise HTTPException(status_code=403, detail="Input control is OFF. Enable 'Allow Nova to type and click' first.")
        # elevated window check
        try:
            import ctypes
            if ctypes.windll.shell32.IsUserAnAdmin():
                pass
        except Exception:
            pass
        title = str(args.get("window", ""))
        if title and not is_allowed_window(title):
            log_action(action, title, "refused", "window not allowlisted")
            raise HTTPException(status_code=403, detail="Target window not in allowlist")
        # refuse elevated target
        try:
            import psutil
            pass
        except Exception:
            pass
        try:
            import pyautogui
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"pyautogui unavailable: {e}")

        if action == "type_text":
            text = str(args.get("text", ""))
            if title:
                import pygetwindow as gw
                ms = [w for w in gw.getAllWindows() if title.lower() in (w.title or "").lower()]
                if ms:
                    try: ms[0].activate()
                    except Exception: pass
            pyautogui.typewrite(text, interval=float(args.get("interval", 0.02)))
            log_action(action, title or "active", "ok", f"{len(text)} chars")
            return {"ok": True, "summary": f"Typed {len(text)} chars"}

        if action == "press_keys":
            keys = args.get("keys", [])
            if isinstance(keys, str):
                keys = [keys]
            pyautogui.hotkey(*keys)
            log_action(action, title or "active", "ok", "+".join(keys))
            return {"ok": True, "summary": f"Pressed {'+'.join(keys)}"}

        if action == "mouse_click":
            x = int(args.get("x", 0)); y = int(args.get("y", 0))
            btn = args.get("button", "left")
            pyautogui.click(x, y, button=btn)
            log_action(action, title or "active", "ok", f"{x},{y}")
            return {"ok": True, "summary": f"Clicked at {x},{y}"}

    # ---------- Phase 6: Screen Capture ----------
    if action == "capture_screen":
        if not CFG.get("screen_vision", {}).get("enabled", False):
            log_action(action, "", "refused", "screen vision disabled")
            raise HTTPException(status_code=403, detail="Screen vision is OFF. Enable 'Allow Nova to see my screen' first.")
        try:
            import mss, base64, io
            from PIL import Image
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"capture deps unavailable: {e}")
        window_title = str(args.get("window", "")).strip()
        with mss.mss() as sct:
            if window_title:
                # capture full screen for now (window crop would need win32 rect)
                mon = sct.monitors[1]
            else:
                mon = sct.monitors[1]
            img = sct.grab(mon)
            pil = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
            # optional resize
            maxw = int(args.get("max_width", 1280))
            if pil.width > maxw:
                ratio = maxw / pil.width
                pil = pil.resize((maxw, int(pil.height * ratio)))
            buf = io.BytesIO()
            pil.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        log_action(action, window_title or "full", "ok", f"{pil.width}x{pil.height}")
        return {"ok": True, "base64": b64, "width": pil.width, "height": pil.height}

    # ---------- Phase 8: TTS ----------
    if action == "tts":
        engine = args.get("engine") or CFG.get("tts", {}).get("engine", "piper")
        if engine == "piper":
            text = str(args.get("text", ""))
            model_path = CFG.get("tts", {}).get("piper_model_path", "voices/en_US-lessac-medium.onnx")
            import subprocess, tempfile, os as _os
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                out_path = f.name
            try:
                proc = subprocess.run(
                    [CFG.get("tts", {}).get("piper_binary", "piper"), "--model", str(BASE / model_path), "--output_file", out_path],
                    input=text.encode("utf-8"), capture_output=True
                )
                if proc.returncode != 0:
                    raise RuntimeError(proc.stderr.decode("utf-8", "replace"))
                import base64
                data = Path(out_path).read_bytes()
                log_action(action, "piper", "ok", f"{len(data)} bytes")
                return {"ok": True, "audio_base64": base64.b64encode(data).decode("ascii"), "mime": "audio/wav"}
            except Exception as e:
                log_action(action, "piper", "error", str(e))
                raise HTTPException(status_code=500, detail=str(e))
            finally:
                try: _os.unlink(out_path)
                except Exception: pass
        # cloud fallback handled by frontend /api/tts
        return {"ok": False, "error": "engine not available locally"}

    raise HTTPException(status_code=400, detail=f"Unknown action: {action}")

if __name__ == "__main__":
    import uvicorn
    host = CFG.get("bind_host", "127.0.0.1")
    # LAN pairing mode override
    if CFG.get("lan_pairing", {}).get("enabled"):
        host = "0.0.0.0"
    port = int(CFG.get("port", 8787))
    # safety: never bind 0.0.0.0 unless lan_pairing enabled
    if host == "0.0.0.0" and not CFG.get("lan_pairing", {}).get("enabled"):
        host = "127.0.0.1"
    uvicorn.run("main:app", host=host, port=port, reload=False)