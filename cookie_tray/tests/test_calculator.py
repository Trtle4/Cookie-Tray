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


def test_cell_h_used_directly_regardless_of_cookie_size():
    spec = ProductSpec(
        cookie_diameter=40.0,
        cookie_thickness=10.0,
        qty_total=10,
        n_cells=2,
        cell_h=35.0,
    )
    params = derive_params(spec)
    assert params.cell_h == pytest.approx(35.0)


def test_cell_h_too_shallow_for_cradle_raises():
    # cell_wid = 40 + 2*1.5 = 43 -> cradle_r defaults to 21.5; cell_h=10 is too shallow.
    spec = ProductSpec(
        cookie_diameter=40.0,
        cookie_thickness=10.0,
        qty_total=10,
        n_cells=2,
        cell_h=10.0,
    )
    with pytest.raises(ValueError, match="cell_h"):
        derive_params(spec)


def test_cell_h_must_be_positive():
    with pytest.raises(ValueError, match="cell_h"):
        ProductSpec(cookie_diameter=45.0, cookie_thickness=12.0, qty_total=24, n_cells=3, cell_h=0.0)


def test_qty_total_must_be_positive():
    with pytest.raises(ValueError, match="qty_total"):
        ProductSpec(cookie_diameter=45.0, cookie_thickness=12.0, qty_total=0, n_cells=3)


def test_rectangle_requires_dimensions():
    with pytest.raises(ValueError, match="rectangle product_type requires"):
        ProductSpec(product_type="rectangle", qty_total=10, n_cells=2)


def test_round_requires_diameter_and_thickness():
    with pytest.raises(ValueError, match="round product_type requires"):
        ProductSpec(product_type="round", qty_total=10, n_cells=2)


def test_invalid_product_type_rejected():
    with pytest.raises(ValueError, match="product_type"):
        ProductSpec(product_type="square", qty_total=10, n_cells=2, cookie_diameter=10, cookie_thickness=5)


def test_rectangle_cell_wid_uses_product_width():
    spec = ProductSpec(
        product_type="rectangle",
        qty_total=10,
        n_cells=2,
        product_width=40.0,
        product_height=20.0,
        product_thickness=10.0,
        side_clearance=2.0,
    )
    params = derive_params(spec)
    assert params.cell_wid == pytest.approx(44.0)


def test_rectangle_cell_len_uses_product_thickness_as_pack_pitch():
    spec = ProductSpec(
        product_type="rectangle",
        qty_total=10,
        n_cells=2,
        product_width=40.0,
        product_height=20.0,
        product_thickness=10.0,
        end_clearance=3.0,
    )
    params = derive_params(spec)
    cookies_per_cell = math.ceil(spec.qty_total / spec.n_cells)
    assert params.cell_len == pytest.approx(cookies_per_cell * 10.0 + 3.0)


def test_rectangle_cradle_r_defaults_to_5mm():
    spec = ProductSpec(
        product_type="rectangle",
        qty_total=10,
        n_cells=2,
        product_width=40.0,
        product_height=20.0,
        product_thickness=10.0,
        side_clearance=0.0,
    )
    params = derive_params(spec)
    assert params.cradle_r == pytest.approx(5.0)


def test_rectangle_cradle_r_clamped_to_cell_wid_half_when_narrow():
    spec = ProductSpec(
        product_type="rectangle",
        qty_total=10,
        n_cells=2,
        product_width=6.0,
        product_height=20.0,
        product_thickness=10.0,
        side_clearance=0.0,
    )
    params = derive_params(spec)
    assert params.cradle_r == pytest.approx(3.0)  # cell_wid/2 = 3.0 < 5.0mm suggestion


def test_rectangle_round_trip_builds_valid_tray():
    spec = ProductSpec(
        product_type="rectangle",
        qty_total=24,
        n_cells=3,
        product_width=40.0,
        product_height=20.0,
        product_thickness=12.0,
        cell_h=25.0,
    )
    params = derive_params(spec)
    part = build_tray(params)
    assert part.val().isValid()
