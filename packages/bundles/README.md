# TeX Bundles

This directory contains pre-bundled TeX Live packages for lazy loading in the browser.

## Files

- `*.data.gz` - Gzipped bundle data files containing concatenated file contents
- `*.meta.json` - Metadata for each bundle (file paths, offsets, sizes)
- `registry.json` - List of all available bundles
- `file-manifest.json` - Combined index of all files across all bundles (maps full path to bundle + offset)
- `package-map.json` - Maps package names (e.g., "geometry") to bundle names
- `package-deps.json` - Package dependency graph extracted from .sty files
- `bundle-deps.json` - Bundle-level dependency graph

## Adding/Modifying Bundles

After adding or modifying any bundle files, run the sync script to update the indices:

```bash
python3 sync-package-map.py
```

This regenerates:
- `package-map.json` - from `*.meta.json` files
- `file-manifest.json` - from `*.meta.json` files

## Adding a Local Package

1. Create/update the bundle data file (e.g., `local-packages.data.gz`)
2. Create/update the metadata file (e.g., `local-packages.meta.json`) with correct paths:
   - Paths MUST start with `/texlive/` (e.g., `/texlive/texmf-dist/tex/latex/mypackage`)
3. Add the bundle to `registry.json`
4. Run `python3 sync-package-map.py`

## Path Convention

All file paths in bundles must start with `/texlive/` to match the TeX Live directory structure used by BusyTeX. The sync script will warn if it finds paths that don't follow this convention.

Example correct path: `/texlive/texmf-dist/tex/latex/preprint/fullpage.sty`
Example incorrect path: `/texmf/texmf-dist/tex/latex/preprint/fullpage.sty`
