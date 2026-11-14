"""The registry: a renderer function registers itself as the maker of one sound id.

    from synth import register, SR

    @register("button_press")
    def button_press(ctx):          # ctx.n samples, ctx.spec is the entry of sounds.json
        return some_float_array     # shape (ctx.n,) or (ctx.n, 2), any level; the build sets it

The build sets the level from the table in levels.py, so a renderer returns the sound at any
convenient scale and never normalises itself.
"""
from __future__ import annotations

import importlib
import json
import pkgutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .core import SR, seeded
from .levels import set_level, target_for

SPEC_PATH = Path(__file__).resolve().parents[1] / "sounds.json"
_SPEC: dict | None = None
REGISTRY: dict[str, "Entry"] = {}


class UnknownSoundError(KeyError):
    pass


def load_spec() -> dict:
    """sounds.json as {"neg": [...], "categories": {id: entry}, "sounds": {id: entry}, "order": [ids]}."""
    global _SPEC
    if _SPEC is None:
        raw = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
        _SPEC = {
            "neg": raw.get("neg", []),
            "categories": {c["id"]: c for c in raw["categories"]},
            "sounds": {s["id"]: s for s in raw["sounds"]},
            "order": [s["id"] for s in raw["sounds"]],
        }
    return _SPEC


@dataclass
class Ctx:
    """What a renderer gets: the sound's entry and some conveniences."""
    id: str
    spec: dict

    @property
    def n(self) -> int:
        return int(round(self.spec["duration"] * SR))

    @property
    def channels(self) -> int:
        return int(self.spec.get("channels", 1))

    @property
    def kind(self) -> str:
        return self.spec["kind"]

    @property
    def params(self) -> dict:
        return self.spec.get("params", {})

    def rng(self, salt: str = ""):
        """A generator fixed by the sound id (and salt). For noise shared by a family use
        synth.seeded("family/name") instead, so that the family members share it."""
        return seeded("sound/%s/%s" % (self.id, salt))


@dataclass
class Entry:
    id: str
    fn: object
    category: str
    swing_max: float | None


def register(sound_id: str, swing_max: float | None = None):
    """Decorator: register the function as the renderer of sound_id.

    Refuses an id that is not in sounds.json and an id that already has a renderer.
    swing_max overrides the largest allowed level swing of a loop in dB (default 6) for loops
    whose content is meant to be an event now and then, such as thermal ticks."""
    spec = load_spec()["sounds"]
    if sound_id not in spec:
        raise UnknownSoundError("%r is not in tools/audio/sounds.json" % sound_id)

    def deco(fn):
        if sound_id in REGISTRY:
            raise ValueError("sound %r already has a renderer" % sound_id)
        REGISTRY[sound_id] = Entry(sound_id, fn, spec[sound_id]["category"], swing_max)
        return fn

    return deco


def is_mid_side(spec: dict) -> bool:
    """True for the sounds that are made as mid and side (SOUND_DESIGN.md section Space): two
    channels on the structure or energy path. Their level is set on the mono sum, and they are
    written with shared dither."""
    return int(spec.get("channels", 1)) == 2 and spec["path"] in ("structure", "energy") and spec["kind"] != "ir"


def load_categories() -> list[str]:
    """Import every synth/cat_*.py so that their renderers register. Returns import errors."""
    errors = []
    pkg = importlib.import_module(__package__)
    for m in pkgutil.iter_modules(pkg.__path__):
        if m.name.startswith("cat_"):
            try:
                importlib.import_module("%s.%s" % (__package__, m.name))
            except Exception as e:  # one broken category must not stop the others
                errors.append("%s: %s: %s" % (m.name, type(e).__name__, e))
    return errors


def render_dry(sound_id: str) -> np.ndarray:
    """Run the renderer and check what it returned. No level setting."""
    entry = REGISTRY.get(sound_id)
    if entry is None:
        raise UnknownSoundError("no renderer registered for %r" % sound_id)
    ctx = Ctx(sound_id, load_spec()["sounds"][sound_id])
    x = np.asarray(entry.fn(ctx), dtype=np.float64)
    want = (ctx.n,) if ctx.channels == 1 else (ctx.n, ctx.channels)
    if x.shape != want:
        raise ValueError("%s returned shape %s, expected %s" % (sound_id, x.shape, want))
    if not np.all(np.isfinite(x)):
        raise ValueError("%s returned NaN or inf" % sound_id)
    return x


def render(sound_id: str):
    """Render a sound to its target level. Returns (float array, level info)."""
    x = render_dry(sound_id)
    spec = load_spec()["sounds"][sound_id]
    mode, value = target_for(sound_id, spec["category"], spec["kind"])
    return set_level(x, mode, value, mono_sum=is_mid_side(spec))
