import pytest
import trimesh

from cookie_tray.geometry import build_tray, export
from cookie_tray.params import TrayParams


def _mesh_for(params: TrayParams, stem: str, tmp_path):
    part = build_tray(params)
    assert part.val().isValid()
    _, stl_path = export(part, stem, out_dir=str(tmp_path))
    mesh = trimesh.load(stl_path)
    return mesh


def _assert_watertight_genus0(mesh):
    assert mesh.is_watertight
    assert mesh.euler_number == 2  # closed, genus 0, no through-holes


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
