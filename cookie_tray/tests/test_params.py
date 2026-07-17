import math
import warnings

import pytest

from cookie_tray.params import MIN_DIVIDER, MIN_WALL, TrayParams


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
    # draft_offset caps at wall - MIN_WALL = 2.2 with the default wall (3.0),
    # so a tiny corner_r triggers this regardless of draft_deg/cell_h.
    with pytest.raises(ValueError, match="corner_r"):
        TrayParams(corner_r=0.1)


def test_draft_offset_bounded_by_wall_regardless_of_cell_height():
    # Tall cells must not push the base taper past wall - MIN_WALL (issue:
    # base undercutting cells on tall trays).
    p = TrayParams(cell_h=80.0)
    unbounded = p.H * math.tan(math.radians(p.draft_deg))
    assert unbounded > p.wall - MIN_WALL  # sanity: this case would have been capped
    assert p.draft_offset == pytest.approx(p.wall - MIN_WALL)


def test_tall_cell_height_is_unrestricted():
    # Previously tall cells could push draft_offset (D) above corner_r and
    # raise, or undercut the base past the wall. Neither happens now.
    p = TrayParams(cell_h=80.0)
    assert p.corner_r > p.draft_offset
    assert p.bottom_corner_r > 0


def test_effective_draft_deg_equals_draft_deg_for_genuinely_short_trays():
    # Short enough that the unbounded inset never reaches the wall cap, so
    # the continuous draft uses the requested angle unmodified.
    p = TrayParams(cell_h=10.0, cell_wid=15.0)
    unbounded = p.H * math.tan(math.radians(p.draft_deg))
    assert unbounded < p.wall - MIN_WALL  # sanity: not capped
    assert p.effective_draft_deg == pytest.approx(p.draft_deg)


def test_effective_draft_deg_less_than_draft_deg_for_tall_trays():
    # Capped: the draft angle itself shrinks (continuous single taper, no
    # step) rather than the taper stopping partway up.
    p = TrayParams(cell_h=80.0)
    assert p.effective_draft_deg < p.draft_deg
    assert p.effective_draft_deg == pytest.approx(
        math.degrees(math.atan(p.draft_offset / p.H))
    )


def test_draft_reduced_warns_when_capped_by_wall():
    with pytest.warns(UserWarning, match="Draft reduced"):
        TrayParams(cell_h=80.0)


def test_draft_not_reduced_does_not_warn_for_short_trays():
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        TrayParams(cell_h=10.0, cell_wid=15.0)


def test_wall_below_min_wall_raises():
    with pytest.raises(ValueError, match="wall"):
        TrayParams(wall=0.5)


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


def test_divider_defaults_to_wall():
    p = TrayParams(wall=4.0, divider=None)
    assert p.divider == pytest.approx(4.0)


def test_divider_equal_to_wall_matches_old_top_W_formula():
    p = TrayParams(n_cells=3, cell_wid=48.0, wall=3.0, divider=3.0)
    old_formula = p.n_cells * p.cell_wid + (p.n_cells + 1) * p.wall
    assert p.top_W == pytest.approx(old_formula)


def test_divider_smaller_than_wall_shrinks_top_W():
    p_thick = TrayParams(n_cells=3, cell_wid=48.0, wall=3.0, divider=3.0)
    p_thin = TrayParams(n_cells=3, cell_wid=48.0, wall=3.0, divider=1.5)
    assert p_thin.top_W < p_thick.top_W
    # Only the two internal dividers shrank (n_cells - 1 = 2), outer walls unchanged.
    assert p_thick.top_W - p_thin.top_W == pytest.approx(2 * (3.0 - 1.5))


def test_pitch_equals_cell_wid_plus_divider():
    p = TrayParams(cell_wid=48.0, divider=2.0)
    assert p.pitch == pytest.approx(50.0)


def test_divider_below_min_divider_raises():
    with pytest.raises(ValueError, match="divider"):
        TrayParams(divider=0.5)


def test_negative_draft_deg_warns_and_clamps_to_zero():
    with pytest.warns(UserWarning, match="draft_deg is negative"):
        p = TrayParams(draft_deg=-10.0)
    assert p.draft_deg == pytest.approx(0.0)
    assert p.draft_offset == pytest.approx(0.0)
    assert p.effective_draft_deg == pytest.approx(0.0)


def test_zero_draft_deg_does_not_warn():
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        TrayParams(draft_deg=0.0)


def test_guard7_lip_h_zero_raises():
    with pytest.raises(ValueError, match="lip_h"):
        TrayParams(lip_h=0.0)


def test_guard7_lip_h_negative_raises():
    with pytest.raises(ValueError, match="lip_h"):
        TrayParams(lip_h=-1.0)


def test_guard7_flange_t_zero_raises():
    with pytest.raises(ValueError, match="flange_t"):
        TrayParams(flange_t=0.0)


def test_guard7_flange_t_negative_raises():
    with pytest.raises(ValueError, match="flange_t"):
        TrayParams(flange_t=-1.0)


def test_guard8_nozzle_negative_raises():
    with pytest.raises(ValueError, match="nozzle"):
        TrayParams(nozzle=-0.1)


def test_guard8_nozzle_zero_is_allowed():
    p = TrayParams(nozzle=0.0)
    assert p.nozzle == 0.0


def test_guard8_cell_fillet_negative_raises():
    with pytest.raises(ValueError, match="cell_fillet"):
        TrayParams(cell_fillet=-1.0)


def test_guard8_cell_fillet_zero_is_allowed():
    p = TrayParams(cell_fillet=0.0)
    assert p.cell_fillet == 0.0
