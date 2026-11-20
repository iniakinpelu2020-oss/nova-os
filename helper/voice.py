"""NOVA // OS — offline wake word listener (Phase 7).

OFF by default. When toggled OFF, the audio stream is fully closed so
Windows shows the mic is not in use. When triggered, notifies the Tauri
window via a local HTTP callback to pop up and activate voice listening.
"""
import json
import threading
import time
from pathlib import Path

import numpy as np
import sounddevice as sd

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"

def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}

class WakeWordListener:
    def __init__(self, on_trigger=None, notify_url=None):
        self.on_trigger = on_trigger
        self.notify_url = notify_url
        self._thread = None
        self._stop = threading.Event()
        self._stream = None
        self.running = False

    def start(self):
        cfg = load_config()
        ww = cfg.get("wake_word", {})
        if not ww.get("enabled", False):
            return False
        if self.running:
            return True
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self.running = True
        return True

    def stop(self):
        self._stop.set()
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        self.running = False

    def _run(self):
        try:
            from openwakeword.model import Model
            model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
        except Exception:
            # fall back: no model available
            self.running = False
            return
        cfg = load_config()
        threshold = float(cfg.get("wake_word", {}).get("threshold", 0.5))
        sr = 16000
        block = 1280
        def callback(indata, frames, time_info, status):
            if self._stop.is_set():
                return
            try:
                audio = (indata[:, 0] * 32767).astype(np.int16)
                pred = model.predict(audio)
                for k, v in pred.items():
                    if v >= threshold:
                        self._trigger()
                        break
            except Exception:
                pass
        try:
            self._stream = sd.InputStream(samplerate=sr, blocksize=block, channels=1,
                                         dtype="float32", callback=callback)
            self._stream.start()
            while not self._stop.is_set():
                time.sleep(0.1)
        finally:
            if self._stream is not None:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None
            self.running = False

    def _trigger(self):
        if self.on_trigger:
            try:
                self.on_trigger()
            except Exception:
                pass
        if self.notify_url:
            try:
                import urllib.request
                urllib.request.urlopen(self.notify_url, timeout=2)
            except Exception:
                pass

if __name__ == "__main__":
    # standalone test
    l = WakeWordListener(on_trigger=lambda: print("WAKE TRIGGERED"))
    if l.start():
        print("listening... (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            l.stop()
    else:
        print("wake word disabled in config")