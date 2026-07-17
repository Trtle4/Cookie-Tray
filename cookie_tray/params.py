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
from math import atan, degrees, radians, tan
from typing import Optional

MIN_WALL = 0.8  # outer-wall floor: draft angle is reduced to respect this
MIN_DIVIDER = 0.8  # internal-divider floor


@dataclass
class TrayParams:
    # ---- Inputs (independent) — spec §3 ----
    n_cells: int = 3
    long_axis: str = "X"  # "X" (length-wise channels) or "Y"
    cell_len: float = 170.0
    cell_wid: float = 48.0
    cell_h: float = 28.0
    cradle_r: Optional[float] = None  # defaults to cell_wid/2
    wall: float = 3.0  # outer-wall thickness
    divider: Optional[float] = None  # internal cell-to-cell wall thickness; defaults to wall
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
        if self.divider is None:
            self.divider = self.wall
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
                "the rounded bottom cannot complete otherwise. Increase cell_h "
                "or decrease cradle_r."
            )

        # Wall floor: draft angle is reduced to fit thin walls (see
        # draft_offset), but the wall itself has a hard minimum.
        if self.wall < MIN_WALL:
            raise ValueError(f"wall ({self.wall}) must be >= {MIN_WALL}mm")
        if self.floor <= 0:
            raise ValueError("floor must be > 0")

        # Negative draft has no physical meaning; clamp to 0 (no draft) and
        # warn, mirroring the cradle_r over-max clamp above -- never reject,
        # since "no draft" is always a valid fallback.
        if self.draft_deg < 0:
            warnings.warn("draft_deg is negative; clamped to 0 (no draft).", stacklevel=3)
            self.draft_deg = 0.0

        # Non-blocking note: draft angle was reduced from draft_deg to keep
        # the base inset within the wall's clearance (see draft_offset).
        full_inset = self.H * tan(radians(self.draft_deg)) if self.draft_deg > 0 else 0.0
        if full_inset > self.draft_offset + 1e-9:
            warnings.warn("Draft reduced to fit a thin wall.", stacklevel=3)

        # Guard 3: corner_r > draft_offset (the wall-limited base inset),
        # else bottom_corner_r goes non-positive and the drafted racetrack
        # degenerates. Cell height is unrestricted: the draft is a single
        # continuous taper over the full height, its angle (not just a
        # bounded band) shrinks to respect the wall.
        if self.corner_r <= self.draft_offset:
            raise ValueError(
                f"corner_r ({self.corner_r}) must exceed the draft inset "
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

        # Guard 6: divider >= MIN_DIVIDER.
        if self.divider < MIN_DIVIDER:
            raise ValueError(f"divider ({self.divider}) must be >= {MIN_DIVIDER}mm")

        # Guard 7: lip_h and flange_t are extruded thicknesses -- zero or
        # negative has no valid interpretation and previously reached OCC
        # construction directly, surfacing as an opaque low-level error.
        if self.lip_h <= 0:
            raise ValueError(f"lip_h ({self.lip_h}) must be > 0")
        if self.flange_t <= 0:
            raise ValueError(f"flange_t ({self.flange_t}) must be > 0")

        # Guard 8: nozzle and cell_fillet are physical/geometric dimensions
        # with no valid negative interpretation (a negative nozzle width
        # inverts the lip's inner-cut sizing; a negative fillet has no
        # meaning). Zero remains valid for both (cell_fillet=0 means "no
        # fillet", a legitimate sharp-corner design choice).
        if self.nozzle < 0:
            raise ValueError(f"nozzle ({self.nozzle}) must be >= 0")
        if self.cell_fillet < 0:
            raise ValueError(f"cell_fillet ({self.cell_fillet}) must be >= 0")

    # ---- Derived (computed, read-only) — spec §3 ----
    @property
    def lip_t(self) -> float:
        return 3 * self.nozzle

    @property
    def top_L(self) -> float:
        return self.cell_len + 2 * self.wall

    @property
    def top_W(self) -> float:
        # Outer walls (both sides) are `wall`; the n_cells-1 internal
        # dividers between cells are `divider`.
        return self.n_cells * self.cell_wid + 2 * self.wall + (self.n_cells - 1) * self.divider

    @property
    def pitch(self) -> float:
        """Cell center-to-center spacing — an alternate view of `divider`
        (pitch = cell_wid + divider). Purely a display/UI convenience; the
        stored input is `divider`."""
        return self.cell_wid + self.divider

    @property
    def H(self) -> float:
        return self.floor + self.cell_h

    @property
    def draft_offset(self) -> float:
        """Base inset applied by the single continuous draft over the full
        height H, limited so the base never insets past ``wall - MIN_WALL``.

        The draft is now always ONE continuous loft from base to rim (no
        vertical band/step): when the wall is thin relative to cell height,
        the *angle* itself shrinks (see ``effective_draft_deg`` in
        geometry.py) rather than tapering steeply for part of the height and
        going vertical for the rest, which used to leave a visible crease.
        """
        max_inset = max(0.0, self.wall - MIN_WALL)
        full_inset = self.H * tan(radians(self.draft_deg)) if self.draft_deg > 0 else 0.0
        return min(full_inset, max_inset)

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
    def effective_draft_deg(self) -> float:
        """The actual (possibly wall-limited) draft angle, continuous over
        the full height H: atan(draft_offset / H)."""
        if self.draft_offset <= 0:
            return 0.0
        return degrees(atan(self.draft_offset / self.H))

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
