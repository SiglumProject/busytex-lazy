#!/usr/bin/env npx ts-node
/**
 * Bundle CTAN Packages
 *
 * Takes downloaded CTAN packages and creates bundles compatible with
 * our lazy-loading system. Updates package-map.json and bundle-deps.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

interface PackageManifest {
  package: string;
  version?: string;
  files: Array<{
    source: string;
    target: string;
    size: number;
  }>;
}

interface BundleFile {
  path: string;
  name: string;
  start: number;
  end: number;
}

interface OutputBundle {
  name: string;
  files: BundleFile[];
  totalSize: number;
}

// Package groupings - group related packages into single bundles
const BUNDLE_GROUPS: Record<string, string[]> = {
  // Graphics mega-bundle (pgf is large, includes tikz)
  'pgf-tikz': ['pgf', 'pgfplots', 'circuitikz'],

  // Presentations
  'beamer': ['beamer'],

  // Typography
  'typography': ['microtype', 'fontspec', 'unicode-math'],

  // Tables
  'tables': ['booktabs', 'longtable', 'multirow', 'tabularx', 'tabularray'],

  // Code listings
  'listings': ['listings', 'minted', 'fancyvrb'],

  // Math extensions
  'math-ext': ['mathtools', 'amsthm', 'thmtools', 'siunitx'],

  // Bibliography
  'biblatex': ['biblatex', 'biber'],

  // Document structure
  'doc-structure': ['geometry', 'fancyhdr', 'titlesec', 'titletoc', 'tocloft', 'appendix'],

  // Floats and captions
  'floats': ['float', 'caption', 'subcaption', 'wrapfig', 'placeins'],

  // Cross-references
  'xref': ['cleveref', 'varioref'],

  // Algorithms
  'algorithms': ['algorithm2e', 'algorithmicx', 'algorithms'],

  // Utilities
  'utils': ['etoolbox', 'xparse', 'xstring', 'environ', 'enumitem', 'parskip', 'setspace', 'lipsum'],

  // Boxes
  'boxes': ['tcolorbox', 'mdframed'],

  // PDF features
  'pdf-tools': ['pdfpages', 'pdflscape'],

  // Symbols
  'symbols': ['fontawesome5', 'dingbat'],
};

// Dependencies between our bundles
const BUNDLE_DEPENDENCIES: Record<string, string[]> = {
  'pgf-tikz': ['graphics', 'xcolor'],
  'beamer': ['pgf-tikz', 'graphics'],
  'typography': ['fonts-lm-otf'],
  'math-ext': ['amsmath'],
  'biblatex': ['bibtex'],
  'floats': ['graphics'],
  'boxes': ['graphics', 'pgf-tikz'],
  'listings': [],
  'tables': [],
  'doc-structure': ['graphics'],
  'xref': ['hyperref'],
  'algorithms': [],
  'utils': [],
  'pdf-tools': ['graphics'],
  'symbols': [],
};

function getPackageBundle(packageName: string): string {
  for (const [bundle, packages] of Object.entries(BUNDLE_GROUPS)) {
    if (packages.includes(packageName)) {
      return bundle;
    }
  }
  // Packages not in a group get their own bundle
  return packageName;
}

async function bundlePackages(
  ctanDir: string,
  outputDir: string
): Promise<void> {
  const manifestPath = path.join(ctanDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}. Run download-ctan.ts first.`);
  }

  const manifests: PackageManifest[] = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log(`Loaded manifest with ${manifests.length} packages`);

  // Group files by bundle
  const bundleFiles = new Map<string, Array<{ source: string; target: string; size: number }>>();

  for (const manifest of manifests) {
    const bundleName = getPackageBundle(manifest.package);

    if (!bundleFiles.has(bundleName)) {
      bundleFiles.set(bundleName, []);
    }

    bundleFiles.get(bundleName)!.push(...manifest.files);
  }

  console.log(`\nCreating ${bundleFiles.size} bundles...`);

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  const registry: OutputBundle[] = [];
  const packageMap: Record<string, string> = {};
  const fileManifest: Record<string, { bundle: string; start: number; end: number }> = {};

  for (const [bundleName, files] of bundleFiles) {
    if (files.length === 0) continue;

    console.log(`\nBundle: ${bundleName} (${files.length} files)`);

    // Build data buffer
    const chunks: Buffer[] = [];
    const bundleFileList: BundleFile[] = [];
    let offset = 0;

    // Sort by target path for consistency
    files.sort((a, b) => a.target.localeCompare(b.target));

    for (const file of files) {
      if (!fs.existsSync(file.source)) {
        console.log(`  Warning: Source not found: ${file.source}`);
        continue;
      }

      const data = fs.readFileSync(file.source);
      const dir = path.dirname(file.target);
      const name = path.basename(file.target);

      bundleFileList.push({
        path: dir,
        name: name,
        start: offset,
        end: offset + data.length,
      });

      // Add to file manifest for lazy loading
      fileManifest[file.target] = {
        bundle: bundleName,
        start: offset,
        end: offset + data.length,
      };

      chunks.push(data);
      offset += data.length;
    }

    if (chunks.length === 0) {
      console.log(`  Skipping empty bundle`);
      continue;
    }

    const bundleData = Buffer.concat(chunks);
    const compressed = zlib.gzipSync(bundleData, { level: 9 });

    // Write bundle data
    const dataPath = path.join(outputDir, `${bundleName}.data.gz`);
    fs.writeFileSync(dataPath, compressed);

    // Write bundle metadata
    const meta: OutputBundle = {
      name: bundleName,
      files: bundleFileList,
      totalSize: bundleData.length,
    };
    fs.writeFileSync(
      path.join(outputDir, `${bundleName}.meta.json`),
      JSON.stringify(meta, null, 2)
    );

    registry.push(meta);

    console.log(`  Size: ${(bundleData.length / 1024 / 1024).toFixed(2)} MB -> ${(compressed.length / 1024 / 1024).toFixed(2)} MB`);

    // Map package names to this bundle
    const packagesInBundle = Object.entries(BUNDLE_GROUPS)
      .find(([b]) => b === bundleName)?.[1] || [bundleName];

    for (const pkg of packagesInBundle) {
      packageMap[pkg] = bundleName;
    }
  }

  // Merge with existing package-map.json
  const existingMapPath = path.join(outputDir, 'package-map.json');
  let existingMap: Record<string, string> = {};
  if (fs.existsSync(existingMapPath)) {
    existingMap = JSON.parse(fs.readFileSync(existingMapPath, 'utf-8'));
  }
  const mergedMap = { ...existingMap, ...packageMap };
  fs.writeFileSync(existingMapPath, JSON.stringify(mergedMap, null, 2));

  // Merge with existing file-manifest.json
  const existingManifestPath = path.join(outputDir, 'file-manifest.json');
  let existingManifest: Record<string, any> = {};
  if (fs.existsSync(existingManifestPath)) {
    existingManifest = JSON.parse(fs.readFileSync(existingManifestPath, 'utf-8'));
  }
  const mergedManifest = { ...existingManifest, ...fileManifest };
  fs.writeFileSync(existingManifestPath, JSON.stringify(mergedManifest));

  // Update bundle-deps.json
  const depsPath = path.join(outputDir, 'bundle-deps.json');
  let deps: any = { engines: {}, bundles: {} };
  if (fs.existsSync(depsPath)) {
    deps = JSON.parse(fs.readFileSync(depsPath, 'utf-8'));
  }
  for (const [bundle, requires] of Object.entries(BUNDLE_DEPENDENCIES)) {
    if (registry.some(r => r.name === bundle)) {
      deps.bundles[bundle] = { requires };
    }
  }
  fs.writeFileSync(depsPath, JSON.stringify(deps, null, 2));

  // Write registry
  fs.writeFileSync(
    path.join(outputDir, 'ctan-registry.json'),
    JSON.stringify(registry.map(r => ({
      name: r.name,
      files: r.files.length,
      size: r.totalSize,
    })), null, 2)
  );

  // Summary
  console.log('\n=== Summary ===');
  let totalSize = 0;
  let totalCompressed = 0;
  for (const bundle of registry) {
    const compressedSize = fs.statSync(path.join(outputDir, `${bundle.name}.data.gz`)).size;
    totalSize += bundle.totalSize;
    totalCompressed += compressedSize;
    console.log(
      `${bundle.name.padEnd(20)} ${(bundle.totalSize / 1024 / 1024).toFixed(2).padStart(8)} MB -> ` +
      `${(compressedSize / 1024 / 1024).toFixed(2).padStart(8)} MB (${bundle.files.length} files)`
    );
  }
  console.log(`${'TOTAL'.padEnd(20)} ${(totalSize / 1024 / 1024).toFixed(2).padStart(8)} MB -> ${(totalCompressed / 1024 / 1024).toFixed(2).padStart(8)} MB`);
  console.log(`\nOutput: ${outputDir}`);
  console.log(`Package map updated: ${Object.keys(packageMap).length} new packages`);
  console.log(`File manifest updated: ${Object.keys(fileManifest).length} new files`);
}

// CLI
const args = process.argv.slice(2);
const ctanDir = args[0] || './ctan-packages';
const outputDir = args[1] || './bundles';

bundlePackages(ctanDir, outputDir).catch(console.error);
