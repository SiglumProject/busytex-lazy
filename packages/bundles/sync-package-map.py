#!/usr/bin/env python3
"""
Sync package-map.json and file-manifest.json with actual bundle contents.
Run this after adding/modifying bundles to ensure all packages are registered.
"""

import json
from pathlib import Path

BUNDLES_DIR = Path(__file__).parent

def main():
    # Load current package-map to preserve any manually added entries
    map_path = BUNDLES_DIR / "package-map.json"
    if map_path.exists():
        with open(map_path) as f:
            existing_map = json.load(f)
    else:
        existing_map = {}

    # Scan all bundles and build complete package map + file manifest
    new_map = {}
    file_manifest = {}
    path_issues = []

    for meta_file in sorted(BUNDLES_DIR.glob("*.meta.json")):
        bundle_name = meta_file.stem.replace('.meta', '')

        with open(meta_file) as f:
            try:
                meta = json.load(f)
            except:
                print(f"ERROR: Could not parse {meta_file}")
                continue

        for file_info in meta.get('files', []):
            name = file_info.get('name', '')
            path = file_info.get('path', '')
            start = file_info.get('start', 0)
            end = file_info.get('end', 0)

            # Build full path for manifest
            full_path = f"{path}/{name}"

            # Add to file manifest (first bundle wins if duplicates)
            if full_path not in file_manifest:
                file_manifest[full_path] = {
                    "bundle": bundle_name,
                    "start": start,
                    "end": end
                }

            # Check for path issues (should start with /texlive/ for tex files)
            if path and name.endswith(('.sty', '.cls', '.def')):
                if not path.startswith('/texlive/'):
                    path_issues.append((bundle_name, full_path, path))

            # Track .sty and .cls packages
            if name.endswith('.sty') or name.endswith('.cls'):
                pkg_name = name[:-4]

                # Don't overwrite existing entries (first bundle wins)
                if pkg_name not in new_map:
                    new_map[pkg_name] = bundle_name

    # Merge: prefer existing map entries (manually curated) over auto-discovered
    final_map = {}
    for pkg in sorted(set(list(new_map.keys()) + list(existing_map.keys()))):
        if pkg in existing_map:
            final_map[pkg] = existing_map[pkg]
        else:
            final_map[pkg] = new_map[pkg]

    # Write the updated package map
    with open(map_path, 'w') as f:
        json.dump(final_map, f, indent=2, sort_keys=True)

    # Write the file manifest (compact format for smaller file size)
    manifest_path = BUNDLES_DIR / "file-manifest.json"
    with open(manifest_path, 'w') as f:
        json.dump(file_manifest, f, separators=(',', ':'))

    print(f"Synced package-map.json:")
    print(f"  Previous entries: {len(existing_map)}")
    print(f"  Auto-discovered: {len(new_map)}")
    print(f"  Final entries: {len(final_map)}")
    print(f"  New packages added: {len(final_map) - len(existing_map)}")

    print(f"\nSynced file-manifest.json:")
    print(f"  Total files: {len(file_manifest)}")

    if path_issues:
        print(f"\nWARNING: {len(path_issues)} files have incorrect paths (should start with /texlive/):")
        for bundle, file, path in path_issues[:10]:
            print(f"  {bundle}: {file}")
        if len(path_issues) > 10:
            print(f"  ... and {len(path_issues) - 10} more")

if __name__ == "__main__":
    main()
