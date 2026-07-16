"""Parametric cookie tray sizer — standalone 3D solid-modeling module.

Sibling to (not an extension of) the FEFCO 201 RSC dieline generator: this
module does genuine 3D B-rep modeling (CadQuery/OpenCASCADE) and exports
STEP + STL, rather than 2D dielines/DXF.

Two front doors, one geometry path:
    - Forward:  TrayParams(...)                    -> build_tray(params)
    - Inverse:  derive_params(ProductSpec(...))     -> build_tray(params)
"""

from .calculator import ProductSpec, derive_params
from .geometry import build_tray, export, rrect, trough_neg
from .params import TrayParams

__all__ = [
    "TrayParams",
    "ProductSpec",
    "derive_params",
    "build_tray",
    "export",
    "rrect",
    "trough_neg",
]
