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


def test_guard3_corner_r_not_exceeding_draft_offset_raises():
    # Large draft_deg / cell_h pushes D above a tiny corner_r.
    with pytest.raises(ValueError, match="corner_r"):
        TrayParams(corner_r=0.5, draft_deg=45.0, cell_h=50.0, floor=5.0)


def test_guard4_strip_w_not_exceeding_lip_t_raises():
    with pytest.raises(ValueError, match="strip_w"):
        TrayParams(strip_w=1.0, nozzle=0.42)  # lip_t = 1.26 > strip_w


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


def test_derived_values_are_read_only():
    p = TrayParams()
    with pytest.raises(AttributeError):
        p.top_L = 999.0


def test_input_dict_round_trips_into_a_new_instance():
    p = TrayParams(n_cells=2, cell_wid=50.0)
    p2 = TrayParams(**p.input_dict())
    assert p2.top_L == pytest.approx(p.top_L)
    assert p2.cradle_r == pytest.approx(p.cradle_r)
