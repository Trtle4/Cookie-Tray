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
    qty_total: int
    product_type: str = "round"  # "round" | "rectangle"
    pack_mode: str = "standing"  # "standing" (packed row, on edge) | "stack" (flat, stacked vertically)

    # ROUND fields (pitch along channel = cookie_thickness; vertical extent = diameter)
    cookie_diameter: Optional[float] = None
    cookie_thickness: Optional[float] = None

    # RECTANGLE fields (product_thickness is the pack pitch along the channel)
    product_width: Optional[float] = None  # across cell (Y)
    product_height: Optional[float] = None  # vertical (Z)
    product_thickness: Optional[float] = None  # along channel (X)
    edge_r_top: float = 0.0
    edge_r_bot: float = 0.0

    n_cells: Optional[int] = None
    cookies_per_cell: Optional[int] = None
    n_cols: int = 1  # columns: splits each cell's packed row across n_cols sub-cells
    side_clearance: float = 1.5
    end_clearance: float = 3.0
    cradle_clearance: float = 0.0
    cell_h: float = 28.0  # explicit trough depth; independent of product size

    # Pass-through §3 inputs not derived from product dims.
    long_axis: str = "X"
    wall: float = 3.0
    divider: Optional[float] = None  # defaults to wall, same as TrayParams
    col_divider: Optional[float] = None  # defaults to divider, same as TrayParams
    floor: float = 2.5
    corner_r: float = 8.0
    draft_deg: float = 5.0
    strip_l: float = 5.0
    strip_w: float = 5.0
    lip_h: float = 3.0
    flange_t: float = 2.5
    cell_fillet: float = 2.0
    nozzle: float = 0.42

    def __post_init__(self) -> None:
        if self.product_type not in ("round", "rectangle"):
            raise ValueError(f'product_type must be "round" or "rectangle", got {self.product_type!r}')
        if self.pack_mode not in ("standing", "stack"):
            raise ValueError(f'pack_mode must be "standing" or "stack", got {self.pack_mode!r}')
        if (self.n_cells is None) == (self.cookies_per_cell is None):
            raise ValueError(
                "Supply exactly one of n_cells or cookies_per_cell, not both/neither."
            )
        if self.qty_total < 1:
            raise ValueError(f"qty_total must be >= 1, got {self.qty_total}")
        if self.n_cols < 1:
            raise ValueError(f"n_cols must be >= 1, got {self.n_cols}")
        if self.product_type == "round":
            if self.cookie_diameter is None or self.cookie_thickness is None:
                raise ValueError("round product_type requires cookie_diameter and cookie_thickness")
            if self.cookie_diameter <= 0 or self.cookie_thickness <= 0:
                raise ValueError("cookie_diameter and cookie_thickness must be > 0")
        else:
            if self.product_width is None or self.product_height is None or self.product_thickness is None:
                raise ValueError(
                    "rectangle product_type requires product_width, product_height, and product_thickness"
                )
            if self.product_width <= 0 or self.product_height <= 0 or self.product_thickness <= 0:
                raise ValueError("product_width, product_height, and product_thickness must be > 0")
        if self.cell_h <= 0:
            raise ValueError(f"cell_h must be > 0, got {self.cell_h}")


def _resolve_product_cell_shape(spec: ProductSpec) -> tuple[float, float, float, float]:
    """The single round/rect branch point: (cell_wid, pack_pitch, vert_extent,
    cradle_r) for the given spec. The round/rectangle rules (cell_wid
    formula, "rectangles suggest a 5mm cradle" rule) live here and nowhere
    else, so they can't drift if a second call site is ever added.
    """
    if spec.product_type == "rectangle":
        cell_wid = spec.product_width + 2 * spec.side_clearance
        pack_pitch = spec.product_thickness
        vert_extent = spec.product_height
    else:
        cell_wid = spec.cookie_diameter + 2 * spec.side_clearance
        pack_pitch = spec.cookie_thickness
        vert_extent = spec.cookie_diameter

    max_cradle_r = cell_wid / 2.0
    if spec.pack_mode == "stack":
        # A product lying flat rests on its own broad face, not a curved
        # side -- same reasoning as the rectangle rule below (a modest fixed
        # radius, not a deep hugging curve), just applied whenever the
        # product lies flat, round or rectangle alike.
        cradle_r = 2.5 - spec.cradle_clearance
    elif spec.product_type == "rectangle":
        # Rectangular products have no natural "radius" to hug; suggest a
        # modest fixed rounded-bottom radius instead of cell_wid/2.
        cradle_r = 5.0 - spec.cradle_clearance
    else:
        cradle_r = cell_wid / 2.0 - spec.cradle_clearance
    cradle_r = min(max(cradle_r, 1e-6), max_cradle_r)  # clamp to (0, cell_wid/2]

    return cell_wid, pack_pitch, vert_extent, cradle_r


def derive_params(spec: ProductSpec) -> TrayParams:
    """Product spec -> a fully-populated :class:`TrayParams`.

    Round-trip requirement (§5): the returned params must pass every §3
    guard. ``TrayParams.__post_init__`` validates on construction, so a bad
    product spec — including a ``cell_h`` too shallow for the cradle it
    implies — surfaces as a ``ValueError`` right here rather than silently
    growing the tray past what was asked for.
    """
    cell_wid, pack_pitch, vert_extent, cradle_r = _resolve_product_cell_shape(spec)

    if spec.cookies_per_cell is not None:
        cookies_per_cell = spec.cookies_per_cell
        n_cells = ceil(spec.qty_total / cookies_per_cell)
    else:
        n_cells = spec.n_cells
        cookies_per_cell = ceil(spec.qty_total / n_cells)

    # cookies_per_cell is the total for one full row; n_cols (default 1, no
    # change in behavior) splits that row's channel into n_cols end-to-end
    # sub-cells (see TrayParams.n_cols/col_divider). Every sub-cell (pocket)
    # gets the same count -- ceil(.../n_cols), since an uneven split (see
    # fill.js's balanced-columns helper) puts the remainder on the busiest
    # column(s), and every pocket shares the same physical size regardless
    # of its own count. This holds for both pack modes; only which physical
    # dimension that count drives differs below.
    max_per_col_cell = ceil(cookies_per_cell / spec.n_cols)
    if spec.pack_mode == "stack":
        # Flat/stacked: each pocket holds a vertical stack of
        # max_per_col_cell products lying flat, so the footprint (cell_len)
        # doesn't grow with the count -- it's just the product's other
        # footprint dimension (round: diameter; rectangle: height) plus
        # clearance. cell_h is NOT auto-derived here (matches this
        # function's existing contract: cell_h always comes from
        # spec.cell_h) -- the caller is responsible for sizing it to fit
        # max_per_col_cell * pack_pitch plus margin, same as it's always
        # been responsible for sizing cell_h in standing mode.
        cell_len = vert_extent + spec.end_clearance
    else:
        cell_len = max_per_col_cell * pack_pitch + spec.end_clearance

    return TrayParams(
        n_cells=n_cells,
        long_axis=spec.long_axis,
        cell_len=cell_len,
        cell_wid=cell_wid,
        cell_h=spec.cell_h,
        cradle_r=cradle_r,
        n_cols=spec.n_cols,
        wall=spec.wall,
        divider=spec.divider,
        col_divider=spec.col_divider,
        floor=spec.floor,
        corner_r=spec.corner_r,
        draft_deg=spec.draft_deg,
        strip_l=spec.strip_l,
        strip_w=spec.strip_w,
        lip_h=spec.lip_h,
        flange_t=spec.flange_t,
        cell_fillet=spec.cell_fillet,
        nozzle=spec.nozzle,
    )
