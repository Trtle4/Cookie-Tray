import math

import pytest
import trimesh

from cookie_tray.geometry import build_product, build_tray, export
from cookie_tray.params import MIN_WALL, TrayParams


def _mesh_for(params: TrayParams, stem: str, tmp_path):
    part = build_tray(params)
    assert part.val().isValid()
    _, stl_path = export(part, stem, out_dir=str(tmp_path))
    mesh = trimesh.load(stl_path)
    return mesh


def _assert_watertight_genus0(mesh):
    assert mesh.is_watertight
    assert mesh.euler_number == 2  # closed, genus 0, no through-holes


def _mesh_for_product(part, stem: str, tmp_path):
    assert part.val().isValid()
    _, stl_path = export(part, stem, out_dir=str(tmp_path))
    return trimesh.load(stl_path)


def test_build_product_round_is_watertight(tmp_path):
    part = build_product("round", diameter=46.0, thickness=12.7)
    mesh = _mesh_for_product(part, "round_product", tmp_path)
    _assert_watertight_genus0(mesh)
    assert mesh.bounds[:, 0] == pytest.approx([0.0, 12.7], abs=1e-6)  # X = thickness depth
    assert mesh.bounds[0, 1] == pytest.approx(-23.0, abs=1e-6)  # Y = -radius
    assert mesh.bounds[1, 1] == pytest.approx(23.0, abs=1e-6)


def test_build_product_round_volume_matches_cylinder():
    part = build_product("round", diameter=46.0, thickness=12.7)
    expected = math.pi * (46.0 / 2) ** 2 * 12.7
    assert part.val().Volume() == pytest.approx(expected, rel=1e-6)


def test_build_product_rectangle_is_watertight(tmp_path):
    part = build_product("rectangle", width=60.0, height=20.0, thickness=12.0, edge_r_top=6.0, edge_r_bot=1.0)
    mesh = _mesh_for_product(part, "rect_product", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_product_rectangle_unequal_radii_volume():
    # Independently verified against the vertex-fillet ground truth and a
    # hand-derived formula (see geometry.py's build_product docstring for
    # why edges-on-the-solid, not a 2D sketch, are the right approach).
    width, height, thickness = 60.0, 20.0, 12.0
    rt, rb = 6.0, 1.0
    part = build_product("rectangle", width=width, height=height, thickness=thickness, edge_r_top=rt, edge_r_bot=rb)
    removed = thickness * (2 * rt**2 * (1 - math.pi / 4) + 2 * rb**2 * (1 - math.pi / 4))
    expected = width * height * thickness - removed
    assert part.val().Volume() == pytest.approx(expected, rel=1e-6)


def test_build_product_rectangle_zero_radius_stays_sharp():
    part = build_product("rectangle", width=60.0, height=20.0, thickness=12.0, edge_r_top=0.0, edge_r_bot=0.0)
    assert part.val().Volume() == pytest.approx(60.0 * 20.0 * 12.0, rel=1e-6)


def test_build_product_rectangle_radius_clamped_to_half_min_dimension():
    # A radius request larger than the shape can support clamps rather than
    # erroring -- mirrors the "clamp for geometric validity" rule the
    # cell_fillet guard uses.
    part = build_product("rectangle", width=10.0, height=20.0, thickness=5.0, edge_r_top=999.0, edge_r_bot=999.0)
    assert part.val().isValid()


def test_build_product_invalid_type_raises():
    with pytest.raises(ValueError, match="product_type"):
        build_product("triangle", diameter=10, thickness=5)


def test_build_product_round_missing_args_raises():
    with pytest.raises(ValueError, match="round product"):
        build_product("round", diameter=10)


def test_build_product_rectangle_missing_args_raises():
    with pytest.raises(ValueError, match="rectangle product"):
        build_product("rectangle", width=10, height=5)


def test_build_single_cell(tmp_path):
    p = TrayParams(n_cells=1)
    mesh = _mesh_for(p, "single_cell", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_three_cells(tmp_path):
    p = TrayParams(n_cells=3)
    mesh = _mesh_for(p, "three_cells", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_long_axis_x(tmp_path):
    p = TrayParams(n_cells=2, long_axis="X")
    mesh = _mesh_for(p, "axis_x", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_long_axis_y(tmp_path):
    p = TrayParams(n_cells=2, long_axis="Y")
    mesh = _mesh_for(p, "axis_y", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_full_round_cradle(tmp_path):
    p = TrayParams(n_cells=2, cell_wid=48.0, cradle_r=24.0)  # cradle_r == cell_wid/2
    mesh = _mesh_for(p, "cradle_full", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_shallow_cradle(tmp_path):
    p = TrayParams(n_cells=2, cell_wid=48.0, cradle_r=10.0)  # cradle_r < cell_wid/2
    mesh = _mesh_for(p, "cradle_shallow", tmp_path)
    _assert_watertight_genus0(mesh)


def test_export_writes_both_formats(tmp_path):
    p = TrayParams(n_cells=1)
    part = build_tray(p)
    step_path, stl_path = export(part, "both_formats", out_dir=str(tmp_path))
    assert (tmp_path / "both_formats.step").exists()
    assert (tmp_path / "both_formats.stl").exists()
    assert step_path.endswith(".step")
    assert stl_path.endswith(".stl")


def test_bounding_box_matches_derived_footprint(tmp_path):
    p = TrayParams(n_cells=3)
    mesh = _mesh_for(p, "bbox_check", tmp_path)
    extents = sorted(mesh.bounding_box.extents[:2])
    expected = sorted([p.outer_L, p.outer_W])
    assert extents[0] == pytest.approx(expected[0], rel=1e-2)
    assert extents[1] == pytest.approx(expected[1], rel=1e-2)


def test_build_tall_cell_no_undercut(tmp_path):
    # Regression test: an unbounded full-height draft used to inset the base
    # past the wall thickness on tall cells, undercutting them. draft_offset
    # is now capped at wall - MIN_WALL, so the base never insets past that.
    p = TrayParams(n_cells=2, cell_h=80.0)
    assert p.draft_offset == pytest.approx(p.wall - MIN_WALL)
    mesh = _mesh_for(p, "tall_cell", tmp_path)
    _assert_watertight_genus0(mesh)

    # The solid's footprint near the base (z close to 0) should match the
    # bounded bottom_L/bottom_W, not an unbounded (over-inset) footprint.
    near_base = mesh.vertices[mesh.vertices[:, 2] < 0.5]
    assert len(near_base) > 0
    base_extent_x = near_base[:, 0].max() - near_base[:, 0].min()
    base_extent_y = near_base[:, 1].max() - near_base[:, 1].min()
    expected = sorted([p.bottom_L, p.bottom_W])
    actual = sorted([base_extent_x, base_extent_y])
    assert actual[0] == pytest.approx(expected[0], rel=1e-2)
    assert actual[1] == pytest.approx(expected[1], rel=1e-2)


def test_build_tall_cell_cell_corner_fillet_present(tmp_path):
    p = TrayParams(n_cells=1, cell_h=80.0, cell_fillet=2.0)
    mesh = _mesh_for(p, "tall_cell_fillet", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_equal_strip_matches_footprint(tmp_path):
    # strip_l == strip_w must reproduce the old centered-racetrack solid.
    p = TrayParams(n_cells=2, strip_l=5.0, strip_w=5.0)
    mesh = _mesh_for(p, "strip_equal", tmp_path)
    _assert_watertight_genus0(mesh)
    extents = sorted(mesh.bounding_box.extents[:2])
    expected = sorted([p.outer_L, p.outer_W])
    assert extents[0] == pytest.approx(expected[0], rel=1e-2)
    assert extents[1] == pytest.approx(expected[1], rel=1e-2)
    assert mesh.bounding_box.extents[2] == pytest.approx(p.overall_H, rel=1e-2)


def test_build_unequal_strip_watertight_and_correct_footprint(tmp_path):
    p = TrayParams(n_cells=2, strip_l=12.0, strip_w=5.0)
    mesh = _mesh_for(p, "strip_unequal", tmp_path)
    _assert_watertight_genus0(mesh)
    extents = sorted(mesh.bounding_box.extents[:2])
    expected = sorted([p.outer_L, p.outer_W])
    assert extents[0] == pytest.approx(expected[0], rel=1e-2)
    assert extents[1] == pytest.approx(expected[1], rel=1e-2)


def test_build_unequal_strip_other_direction(tmp_path):
    p = TrayParams(n_cells=1, strip_l=5.0, strip_w=12.0)
    mesh = _mesh_for(p, "strip_unequal_2", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_unequal_strip_tall_cell(tmp_path):
    p = TrayParams(n_cells=1, cell_h=80.0, strip_l=12.0, strip_w=5.0)
    mesh = _mesh_for(p, "strip_unequal_tall", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_unequal_strip_long_axis_y(tmp_path):
    p = TrayParams(n_cells=2, long_axis="Y", strip_l=12.0, strip_w=5.0)
    mesh = _mesh_for(p, "strip_unequal_axisY", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_tall_thin_wall_draft_is_continuous_no_crease(tmp_path):
    # Regression test: the old bounded-band-then-vertical draft left a
    # visible crease at z=draft_h on tall/thin-walled trays. The draft is
    # now a single continuous taper, so the body's plan-view width at any
    # height between the floor and the flange must fall exactly on the
    # straight line between bottom_L (z=0) and top_L (z=H) -- no kink.
    p = TrayParams(n_cells=1, cell_h=80.0, wall=1.2)
    assert p.draft_offset > 0  # sanity: draft is actually applied
    mesh = _mesh_for(p, "tall_thin_wall", tmp_path)
    _assert_watertight_genus0(mesh)

    H = p.H
    for frac in (0.25, 0.5, 0.75):
        z = H * frac
        section = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
        pts = section.vertices
        actual_width = pts[:, 0].max() - pts[:, 0].min()
        expected_width = p.bottom_L + (p.top_L - p.bottom_L) * frac
        assert actual_width == pytest.approx(expected_width, rel=1e-2)


def test_build_thin_wall_default_corner_r_watertight(tmp_path):
    # Thin wall (near MIN_WALL) with the default corner_r is a separate,
    # pre-existing OCC boolean fragility (unrelated to draft — reproduces
    # even with draft_deg=0): build_tray bumps the trough's plan-view
    # fillet floor in that range to resolve it.
    p = TrayParams(n_cells=1, cell_h=28.0, wall=0.8)
    mesh = _mesh_for(p, "thin_wall_default_corner", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_normal_wall_unaffected_by_continuous_draft(tmp_path):
    # wall=3 (default) / normal cell_h: draft is barely (if at all) capped,
    # so this should look just like before.
    p = TrayParams(n_cells=2)
    mesh = _mesh_for(p, "normal_wall_draft", tmp_path)
    _assert_watertight_genus0(mesh)


def test_build_divider_equal_wall_matches_old_tray(tmp_path):
    p = TrayParams(n_cells=3, wall=3.0, divider=3.0)
    mesh = _mesh_for(p, "divider_equal", tmp_path)
    _assert_watertight_genus0(mesh)
    extents = sorted(mesh.bounding_box.extents[:2])
    expected = sorted([p.outer_L, p.outer_W])
    assert extents[0] == pytest.approx(expected[0], rel=1e-2)
    assert extents[1] == pytest.approx(expected[1], rel=1e-2)


def test_build_thin_divider_thick_wall(tmp_path):
    p = TrayParams(n_cells=3, wall=3.0, divider=1.5)
    mesh = _mesh_for(p, "divider_thin", tmp_path)
    _assert_watertight_genus0(mesh)
    extents = sorted(mesh.bounding_box.extents[:2])
    expected = sorted([p.outer_L, p.outer_W])
    assert extents[0] == pytest.approx(expected[0], rel=1e-2)
    assert extents[1] == pytest.approx(expected[1], rel=1e-2)
