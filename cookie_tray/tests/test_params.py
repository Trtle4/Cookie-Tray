import math

import pytest

from cookie_tray.params import TrayParams


def test_defaults_build_without_error():
    p = TrayParams()
    assert p.cradle_r == pytest.approx(p.cell_wid / 2)


def test_cradle_r_defaults_to_half_width():
    p = TrayParams(cell_wid=48.0, cradle_r=None)
    assert p.cradle_r == pytest.approx(24.0)


def test_guard1_cradle_r_clamped_with_warning():
    with pytest.warns(UserWarning, match="clamping"):
        p = TrayParams(cell_wid=48.0, cell_h=40.0, cradle_r=100.0)
    assert p.cradle_r == pytest.approx(24.0)


def test_guard2_cell_h_less_than_cradle_r_raises():
    with pytest.raises(ValueError, match="cell_h"):
        TrayParams(cell_wid=48.0, cell_h=5.0, cradle_r=24.0)


def test_guard3_corner_r_not_exceeding_base_offset_raises():
    # draft_offset caps at wall - 0.5 = 2.5 with the default wall (3.0), so a
    # tiny corner_r triggers this regardless of draft_deg/cell_h.
    with pytest.raises(ValueError, match="corner_r"):
        TrayParams(corner_r=0.1)


def test_draft_offset_bounded_by_wall_regardless_of_cell_height():
    # Tall cells must not push the base taper past wall - 0.5 (issue: base
    # undercutting cells on tall trays).
    p = TrayParams(cell_h=80.0)
    unbounded = p.H * math.tan(math.radians(p.draft_deg))
    assert unbounded > p.wall - 0.5  # sanity: this case would have been capped
    assert p.draft_offset == pytest.approx(p.wall - 0.5)


def test_tall_cell_height_is_unrestricted():
    # Previously tall cells could push draft_offset (D) above corner_r and
    # raise, or undercut the base past the wall. Neither happens now.
    p = TrayParams(cell_h=80.0)
    assert p.corner_r > p.draft_offset
    assert p.bottom_corner_r > 0


def test_draft_h_equals_H_for_genuinely_short_trays():
    # Short enough that the unbounded taper never reaches the wall cap, so
    # the taper spans the full height (single loft, unchanged from before).
    p = TrayParams(cell_h=10.0, cell_wid=15.0)
    unbounded = p.H * math.tan(math.radians(p.draft_deg))
    assert unbounded < p.wall - 0.5  # sanity: not capped
    assert p.draft_h == pytest.approx(p.H)


def test_draft_h_less_than_H_for_tall_trays():
    p = TrayParams(cell_h=80.0)
    assert p.draft_h < p.H


def test_guard4_strip_w_not_exceeding_lip_t_raises():
    with pytest.raises(ValueError, match="strip_w"):
        TrayParams(strip_w=1.0, nozzle=0.42)  # lip_t = 1.26 > strip_w


def test_guard4_strip_l_not_exceeding_lip_t_raises():
    with pytest.raises(ValueError, match="strip_l"):
        TrayParams(strip_l=1.0, nozzle=0.42)  # lip_t = 1.26 > strip_l


def test_guard5_cell_wid_too_small_for_fillet_raises():
    with pytest.raises(ValueError, match="cell_wid"):
        TrayParams(cell_wid=3.0, cell_fillet=2.0)


def test_guard5_cell_len_too_small_for_fillet_raises():
    with pytest.raises(ValueError, match="cell_len"):
        TrayParams(cell_len=3.0, cell_fillet=2.0)


def test_n_cells_must_be_at_least_one():
    with pytest.raises(ValueError, match="n_cells"):
        TrayParams(n_cells=0)


def test_long_axis_must_be_x_or_y():
    with pytest.raises(ValueError, match="long_axis"):
        TrayParams(long_axis="Z")


def test_derived_values():
    p = TrayParams(
        n_cells=3,
        cell_len=170.0,
        cell_wid=48.0,
        cell_h=28.0,
        wall=3.0,
        floor=2.5,
        corner_r=8.0,
        draft_deg=5.0,
        strip_l=5.0,
        strip_w=5.0,
        lip_h=3.0,
        nozzle=0.42,
    )
    assert p.lip_t == pytest.approx(1.26)
    assert p.top_L == pytest.approx(170.0 + 6.0)
    assert p.top_W == pytest.approx(3 * 48.0 + 4 * 3.0)
    assert p.H == pytest.approx(30.5)
    assert p.outer_L == pytest.approx(p.top_L + 10.0)
    assert p.outer_W == pytest.approx(p.top_W + 10.0)
    assert p.outer_r == pytest.approx(13.0)
    assert p.overall_H == pytest.approx(p.H + 3.0)
    assert p.footprint == pytest.approx(p.outer_L * p.outer_W)
    assert p.bottom_corner_r == pytest.approx(p.corner_r - p.draft_offset)


def test_derived_values_unequal_strip_l_strip_w():
    p = TrayParams(n_cells=2, strip_l=12.0, strip_w=5.0)
    assert p.outer_L == pytest.approx(p.top_L + 24.0)
    assert p.outer_W == pytest.approx(p.top_W + 10.0)
    assert p.outer_r == pytest.approx(p.corner_r + 5.0)  # min(strip_l, strip_w)


def test_derived_values_are_read_only():
    p = TrayParams()
    with pytest.raises(AttributeError):
        p.top_L = 999.0


def test_input_dict_round_trips_into_a_new_instance():
    p = TrayParams(n_cells=2, cell_wid=50.0)
    p2 = TrayParams(**p.input_dict())
    assert p2.top_L == pytest.approx(p.top_L)
    assert p2.cradle_r == pytest.approx(p.cradle_r)
