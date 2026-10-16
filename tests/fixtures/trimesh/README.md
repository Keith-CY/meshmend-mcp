# Real-world STL files from trimesh

`multibody.stl`, `teapot.stl` and `featuretype.STL` are unmodified copies of
files in the `models/` folder of [trimesh](https://github.com/mikedh/trimesh)
(commit dc8490c, October 2026), used under its MIT licence (`LICENSE.md` here).

| File | What is wrong with it | MeshMend's verdict |
|---|---|---|
| `multibody.stl` | 2 shells, both inside out, 12 winding conflicts | repairable: closed and outward after repair_mesh |
| `teapot.stl` | The Utah teapot: 6 open boundaries (64 open edges), 1 non-manifold vertex | needs manual review |
| `featuretype.STL` | A CAD export with 16 open seams (576 open edges) between surfaces whose vertices do not match | needs manual review (MeshMend never welds nearby vertices) |
