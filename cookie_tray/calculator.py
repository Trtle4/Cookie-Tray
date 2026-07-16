"""Inverse calculator: product dimensions -> tray parameters (spec §5).

Layouts are 1xN, so there is no 2D row x col factoring like the pallet
optimizer -- just distribute a cookie count along one axis. The output is a
:class:`~cookie_tray.params.TrayParams`, the exact same parameter object the
forward (direct-input) path produces, so both feed
:func:`cookie_tray.geometry.build_tray` unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil
from typing import Optional

from .params import TrayParams


@dataclass
class ProductSpec:
    cookie_diameter: float
    cookie_thickness: float
    qty_total: int
    n_cells: Optional[int] = None
    cookies_per_cell: Optional[int] = None
    side_clearance: float = 1.5
    end_clearance: float = 3.0
    cradle_clearance: float = 0.0
    cell_h: float = 28.0  # explicit trough depth; independent of cookie size

    # Pass-through §3 inputs not derived from product dims.
    long_axis: str = "X"
    wall: float = 3.0
    floor: float = 2.5
    corner_r: float = 8.0
    draft_deg: float = 5.0
    strip_w: float = 5.0
    lip_h: float = 3.0
    flange_t: float = 2.5
    cell_fillet: float = 2.0
    nozzle: float = 0.42

    def __post_init__(self) -> None:
        if (self.n_cells is None) == (self.cookies_per_cell is None):
            raise ValueError(
                "Supply exactly one of n_cells or cookies_per_cell, not both/neither."
            )
        if self.qty_total < 1:
            raise ValueError(f"qty_total must be >= 1, got {self.qty_total}")
        if self.cookie_diameter <= 0 or self.cookie_thickness <= 0:
            raise ValueError("cookie_diameter and cookie_thickness must be > 0")
        if self.cell_h <= 0:
            raise ValueError(f"cell_h must be > 0, got {self.cell_h}")


def derive_params(spec: ProductSpec) -> TrayParams:
    """Product spec -> a fully-populated :class:`TrayParams`.

    Round-trip requirement (§5): the returned params must pass every §3
    guard. ``TrayParams.__post_init__`` validates on construction, so a bad
    product spec — including a ``cell_h`` too shallow for the cradle it
    implies — surfaces as a ``ValueError`` right here rather than silently
    growing the tray past what was asked for.
    """
    cell_wid = spec.cookie_diameter + 2 * spec.side_clearance

    max_cradle_r = cell_wid / 2.0
    cradle_r = cell_wid / 2.0 - spec.cradle_clearance
    cradle_r = min(max(cradle_r, 1e-6), max_cradle_r)  # clamp to (0, cell_wid/2]

    if spec.cookies_per_cell is not None:
        cookies_per_cell = spec.cookies_per_cell
        n_cells = ceil(spec.qty_total / cookies_per_cell)
    else:
        n_cells = spec.n_cells
        cookies_per_cell = ceil(spec.qty_total / n_cells)

    cell_len = cookies_per_cell * spec.cookie_thickness + spec.end_clearance

    return TrayParams(
        n_cells=n_cells,
        long_axis=spec.long_axis,
        cell_len=cell_len,
        cell_wid=cell_wid,
        cell_h=spec.cell_h,
        cradle_r=cradle_r,
        wall=spec.wall,
        floor=spec.floor,
        corner_r=spec.corner_r,
        draft_deg=spec.draft_deg,
        strip_w=spec.strip_w,
        lip_h=spec.lip_h,
        flange_t=spec.flange_t,
        cell_fillet=spec.cell_fillet,
        nozzle=spec.nozzle,
    )
