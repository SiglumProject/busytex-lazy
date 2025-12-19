#!/usr/bin/env python3
"""
Extract package dependencies from bundle .data.gz files.
Scans for RequirePackage and usepackage statements in .sty files.
"""

import gzip
import json
import re
import os
from pathlib import Path

BUNDLES_DIR = Path(__file__).parent
PACKAGE_MAP_PATH = BUNDLES_DIR / "package-map.json"
OUTPUT_PATH = BUNDLES_DIR / "package-deps.json"

# Pattern to match \RequirePackage{pkg} or \RequirePackage[opts]{pkg}
# Need double backslash in the raw string to match a literal backslash in the file
REQUIRE_PATTERN = re.compile(rb'\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}')
# Also match \usepackage for completeness
USE_PATTERN = re.compile(rb'\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}')

def extract_deps_from_bundle(bundle_path: Path) -> dict[str, list[str]]:
    """Extract package -> dependencies mapping from a bundle."""
    deps = {}

    # Read the meta.json to get file offsets
    # bundle_path is like "tex-latex-misc.data.gz", we need "tex-latex-misc.meta.json"
    bundle_name = bundle_path.name.replace('.data.gz', '')
    meta_path = bundle_path.with_name(bundle_name + '.meta.json')
    if not meta_path.exists():
        return deps

    with open(meta_path) as f:
        meta = json.load(f)

    files = meta.get('files', [])
    if not files:
        return deps

    # Read and decompress the data
    with gzip.open(bundle_path, 'rb') as f:
        data = f.read()

    # For each .sty file, extract its content and scan for deps
    for file_info in files:
        name = file_info.get('name', '')
        if not name.endswith('.sty'):
            continue

        # Get the package name from the .sty filename
        pkg_name = Path(name).stem

        # Get file content from the data using offsets
        start = file_info.get('start', 0)
        end = file_info.get('end', 0)
        if start >= end:
            continue

        content = data[start:end]

        # Scan for RequirePackage and usepackage
        found_deps = set()

        for match in REQUIRE_PATTERN.finditer(content):
            pkgs = match.group(1).decode('utf-8', errors='ignore')
            for pkg in pkgs.split(','):
                pkg = pkg.strip()
                if pkg and pkg != pkg_name:  # Don't include self
                    found_deps.add(pkg)

        for match in USE_PATTERN.finditer(content):
            pkgs = match.group(1).decode('utf-8', errors='ignore')
            for pkg in pkgs.split(','):
                pkg = pkg.strip()
                if pkg and pkg != pkg_name:
                    found_deps.add(pkg)

        if found_deps:
            deps[pkg_name] = sorted(found_deps)

    return deps

def main():
    # Load package-map.json to know which packages exist in our bundles
    with open(PACKAGE_MAP_PATH) as f:
        package_map = json.load(f)

    all_known_packages = set(package_map.keys())

    # Find all bundle data files
    bundle_files = sorted(BUNDLES_DIR.glob("*.data.gz"))

    # Extract deps from each bundle
    all_deps = {}

    for bundle_path in bundle_files:
        bundle_name = bundle_path.stem.replace('.data', '')

        bundle_deps = extract_deps_from_bundle(bundle_path)

        for pkg, deps in bundle_deps.items():
            # Keep all dependencies - we may need deps outside our bundles
            # (they'll be fetched from CTAN at runtime)
            if deps:
                all_deps[pkg] = deps

        if bundle_deps:
            print(f"Processing {bundle_name}... Found {len(bundle_deps)} packages with deps")

    # Write output
    output = {
        "$comment": "Package dependencies extracted from bundle .sty files. Maps package name to list of required packages.",
        "packages": all_deps
    }

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, indent=2, sort_keys=True)

    print(f"\nWrote {len(all_deps)} packages with dependencies to {OUTPUT_PATH}")

    # Show some examples
    print("\nSample dependencies:")
    for pkg in ['geometry', 'hyperref', 'tikz', 'amsmath', 'fontspec'][:5]:
        if pkg in all_deps:
            print(f"  {pkg}: {all_deps[pkg]}")

if __name__ == "__main__":
    main()
