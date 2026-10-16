# Changelog

## 0.1.0 (2026-10-16)

- First release: `check_mesh`, `repair_mesh` and `convert_3mf_to_stl` over stdio, using MeshMend's mesh code (mesh-mend commit 6b17aec) unchanged.
- `check_mesh` verdicts come from a trial repair in memory: ok, repairable, partly_repairable or needs_manual_review.
- Results never replace the input; default output names add `-2`, `-3`, … instead of overwriting.
- One bundled file (`dist/meshmend-mcp.js`, no runtime dependencies) for `npx github:Keith-CY/meshmend-mcp`, and an MCPB bundle for Claude Desktop.
