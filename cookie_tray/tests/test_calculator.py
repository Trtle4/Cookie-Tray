import math

import pytest

from cookie_tray.calculator import ProductSpec, derive_params
from cookie_tray.geometry import build_tray


def test_requires_exactly_one_of_n_cells_or_cookies_per_cell():
    with pytest.raises(ValueError, match="exactly one"):
        ProductSpec(cookie_diameter=45.0, cookie_thickness=12.0, qty_total=24)
    with pytest.raises(ValueError, match="exactly one"):
        ProductSpec(
            cookie_diameter=45.0,
            cookie_thickness=12.0,
            qty_total=24,
            n_cells=3,
            cookies_per_cell=8,
        )


def test_round_trip_with_n_cells_given():
    spec = ProductSpec(
        cookie_diameter=45.0,
        cookie_thickness=12.0,
        qty_total=24,
        n_cells=3,
    )
    params = derive_params(spec)
    cookies_per_cell = math.ceil(spec.qty_total / spec.n_cells)
    assert params.n_cells == spec.n_cells
    assert params.n_cells * cookies_per_cell >= spec.qty_total
    part = build_tray(params)
    assert part.val().isValid()


def test_round_trip_with_cookies_per_cell_given():
    spec = ProductSpec(
        cookie_diameter=45.0,
        cookie_thickness=12.0,
        qty_total=24,
        cookies_per_cell=8,
    )
    params = derive_params(spec)
    assert params.n_cells == math.ceil(spec.qty_total / spec.cookies_per_cell)
    assert spec.cookies_per_cell * params.n_cells >= spec.qty_total
    part = build_tray(params)
    assert part.val().isValid()


def test_cell_wid_includes_side_clearance():
    spec = ProductSpec(
        cookie_diameter=40.0,
        cookie_thickness=10.0,
        qty_total=10,
        n_cells=2,
        side_clearance=2.0,
    )
    params = derive_params(spec)
    assert params.cell_wid == pytest.approx(44.0)


def test_cradle_clearance_shrinks_cradle_r():
    spec = ProductSpec(
        cookie_diameter=40.0,
        cookie_thickness=10.0,
        qty_total=10,
        n_cells=2,
        side_clearance=0.0,
        cradle_clearance=5.0,
    )
    params = derive_params(spec)
    assert params.cradle_r == pytest.approx(20.0 - 5.0)


def test_default_depth_used_when_larger_than_cradle_r():
    spec = ProductSpec(
        cookie_diameter=40.0,
        cookie_thickness=10.0,
        qty_total=10,
        n_cells=2,
        default_depth=28.0,
    )
    params = derive_params(spec)
    assert params.cell_h == pytest.approx(28.0)


def test_qty_total_must_be_positive():
    with pytest.raises(ValueError, match="qty_total"):
        ProductSpec(cookie_diameter=45.0, cookie_thickness=12.0, qty_total=0, n_cells=3)
