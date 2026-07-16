"""Parameter model for the parametric cookie tray sizer.

Single source of truth: :class:`TrayParams` holds the independent inputs from
spec §3. Every derived quantity (§3 "Derived") is exposed as a read-only
``@property`` computed from those inputs -- there is no second place derived
values can be written, so forward (direct param) and inverse (calculator)
usage always feed the same object into ``geometry.build_tray``.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, fields
from math import radians, tan
from typing import Optional


@dataclass
class TrayParams:
    # ---- Inputs (independent) — spec §3 ----
    n_cells: int = 3
    long_axis: str = "X"  # "X" (length-wise channels) or "Y"
    cell_len: float = 170.0
    cell_wid: float = 48.0
    cell_h: float = 28.0
    cradle_r: Optional[float] = None  # defaults to cell_wid/2
    wall: float = 3.0
    floor: float = 2.5
    corner_r: float = 8.0
    draft_deg: float = 5.0
    strip_l: float = 5.0  # flange strip width on the +/-X (long-axis) sides
    strip_w: float = 5.0  # flange strip width on the +/-Y (width-axis) sides
    lip_h: float = 3.0
    flange_t: float = 2.5
    cell_fillet: float = 2.0
    nozzle: float = 0.42

    def __post_init__(self) -> None:
        if self.cradle_r is None:
            self.cradle_r = self.cell_wid / 2.0
        self._validate()

    # ---- Validation guards — spec §3 ----
    def _validate(self) -> None:
        if self.n_cells < 1:
            raise ValueError(f"n_cells must be >= 1, got {self.n_cells}")
        if self.long_axis not in ("X", "Y"):
            raise ValueError(f'long_axis must be "X" or "Y", got {self.long_axis!r}')

        # Guard 1: cradle_r = min(cradle_r, cell_wid/2), warn if clamped.
        max_cradle_r = self.cell_wid / 2.0
        if self.cradle_r > max_cradle_r:
            warnings.warn(
                f"cradle_r={self.cradle_r} exceeds cell_wid/2={max_cradle_r}; clamping.",
                stacklevel=3,
            )
            self.cradle_r = max_cradle_r
        if self.cradle_r <= 0:
            raise ValueError(f"cradle_r must be > 0, got {self.cradle_r}")

        # Guard 2: cell_h >= cradle_r, otherwise the rounded bottom can't complete.
        if self.cell_h < self.cradle_r:
            raise ValueError(
                f"cell_h ({self.cell_h}) must be >= cradle_r ({self.cradle_r}); "
                "the rounded bottom cannot complete otherwise."
            )

        # Guard 3: corner_r > base_offset (the bounded base taper offset,
        # never more than wall - 0.5mm — see draft_offset), else
        # bottom_corner_r goes non-positive and the drafted racetrack
        # degenerates. Cell height is unrestricted since draft_offset is
        # capped regardless of how tall the cell is.
        if self.corner_r <= self.draft_offset:
            raise ValueError(
                f"corner_r ({self.corner_r}) must exceed the base taper offset "
                f"({self.draft_offset:.4f}); otherwise bottom_corner_r is non-positive."
            )

        # Guard 4: strip_l > lip_t and strip_w > lip_t, else the lip consumes
        # the whole strip on that axis.
        if self.strip_l <= self.lip_t:
            raise ValueError(
                f"strip_l ({self.strip_l}) must exceed lip_t ({self.lip_t:.4f}); "
                "otherwise the lip consumes the whole flange strip."
            )
        if self.strip_w <= self.lip_t:
            raise ValueError(
                f"strip_w ({self.strip_w}) must exceed lip_t ({self.lip_t:.4f}); "
                "otherwise the lip consumes the whole flange strip."
            )

        # Guard 5: cell_wid > 2*cell_fillet and cell_len > 2*cell_fillet.
        if self.cell_wid <= 2 * self.cell_fillet:
            raise ValueError(
                f"cell_wid ({self.cell_wid}) must exceed 2*cell_fillet "
                f"({2 * self.cell_fillet})"
            )
        if self.cell_len <= 2 * self.cell_fillet:
            raise ValueError(
                f"cell_len ({self.cell_len}) must exceed 2*cell_fillet "
                f"({2 * self.cell_fillet})"
            )

        if self.wall <= 0 or self.floor <= 0:
            raise ValueError("wall and floor must be > 0")

    # ---- Derived (computed, read-only) — spec §3 ----
    @property
    def lip_t(self) -> float:
        return 3 * self.nozzle

    @property
    def top_L(self) -> float:
        return self.cell_len + 2 * self.wall

    @property
    def top_W(self) -> float:
        return self.n_cells * self.cell_wid + (self.n_cells + 1) * self.wall

    @property
    def H(self) -> float:
        return self.floor + self.cell_h

    @property
    def draft_offset(self) -> float:
        """Base taper offset actually applied to the body's bottom footprint.

        Bounded to never exceed ``wall - 0.5``mm, regardless of how tall the
        cell is: an unbounded ``H * tan(draft_deg)`` would inset the base
        past the wall thickness on tall cells, undercutting the cells (see
        ``geometry.build_tray``, which lofts only up to ``draft_h`` and goes
        vertical above that instead of tapering over the full height ``H``).
        """
        unbounded = self.H * tan(radians(self.draft_deg)) if self.draft_deg > 0 else 0.0
        return max(0.0, min(unbounded, self.wall - 0.5))

    @property
    def draft_h(self) -> float:
        """Height at which the base taper completes and walls go vertical."""
        if self.draft_deg <= 0 or self.draft_offset <= 0:
            return 0.0
        return self.draft_offset / tan(radians(self.draft_deg))

    @property
    def bottom_L(self) -> float:
        return self.top_L - 2 * self.draft_offset

    @property
    def bottom_W(self) -> float:
        return self.top_W - 2 * self.draft_offset

    @property
    def bottom_corner_r(self) -> float:
        return self.corner_r - self.draft_offset

    @property
    def outer_L(self) -> float:
        return self.top_L + 2 * self.strip_l

    @property
    def outer_W(self) -> float:
        return self.top_W + 2 * self.strip_w

    @property
    def outer_r(self) -> float:
        # min() keeps the corner blend clean when the two strip widths differ.
        return self.corner_r + min(self.strip_l, self.strip_w)

    @property
    def overall_H(self) -> float:
        return self.H + self.lip_h

    @property
    def footprint(self) -> float:
        return self.outer_L * self.outer_W

    def input_dict(self) -> dict:
        """The independent inputs only (no derived values) — e.g. for build_tray(**kwargs)."""
        return {f.name: getattr(self, f.name) for f in fields(self)}
