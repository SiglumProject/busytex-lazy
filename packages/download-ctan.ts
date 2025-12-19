#!/usr/bin/env npx ts-node
/**
 * Download CTAN Packages
 *
 * Downloads packages from CTAN and prepares them for bundling.
 * Uses the CTAN JSON API to find package info and downloads TDS zip files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';

// Common packages that users frequently request
const COMMON_PACKAGES = [
  // Graphics and diagrams
  'pgf',           // includes tikz
  'pgfplots',      // plotting with tikz
  'circuitikz',    // circuit diagrams

  // Presentations
  'beamer',

  // Typography
  'microtype',
  'fontspec',      // already have some, but ensure complete
  'unicode-math',

  // Tables
  'booktabs',
  'longtable',
  'multirow',
  'tabularx',
  'tabularray',

  // Code listings
  'listings',
  'minted',
  'fancyvrb',

  // Math
  'mathtools',
  'amsthm',
  'thmtools',
  'siunitx',

  // Bibliography
  'biblatex',
  'biber',         // biblatex backend

  // Document structure
  'geometry',
  'fancyhdr',
  'titlesec',
  'titletoc',
  'tocloft',
  'appendix',

  // Floats and captions
  'float',
  'caption',
  'subcaption',
  'wrapfig',
  'placeins',

  // Cross-references
  'cleveref',
  'varioref',

  // Algorithms
  'algorithm2e',
  'algorithmicx',
  'algorithms',

  // Misc utilities
  'etoolbox',
  'xparse',
  'xstring',
  'environ',
  'enumitem',
  'parskip',
  'setspace',
  'lipsum',

  // Colors and boxes
  'tcolorbox',
  'mdframed',

  // PDF features
  'pdfpages',
  'pdflscape',

  // Symbols
  'fontawesome5',
  'dingbat',
];

interface CTANPackageInfo {
  id: string;
  name: string;
  install?: string;  // TDS zip path
  ctan?: {
    path: string;
    file: boolean;
  };
  version?: {
    number: string;
    date: string;
  };
}

async function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 307 || res.statusCode === 302) {
        // Follow redirect
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          fetchJSON(redirectUrl).then(resolve).catch(reject);
          return;
        }
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;

    const request = (currentUrl: string) => {
      protocol.get(currentUrl, (res) => {
        if (res.statusCode === 307 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            request(redirectUrl);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

async function getPackageInfo(packageName: string): Promise<CTANPackageInfo | null> {
  try {
    const info = await fetchJSON(`https://ctan.org/json/2.0/pkg/${packageName}`);
    if (info.errors) {
      console.log(`  Package not found: ${packageName}`);
      return null;
    }
    return info;
  } catch (e) {
    console.log(`  Error fetching info for ${packageName}: ${e}`);
    return null;
  }
}

async function downloadPackage(
  packageName: string,
  outputDir: string
): Promise<{ success: boolean; files: string[] }> {
  console.log(`\nProcessing: ${packageName}`);

  const info = await getPackageInfo(packageName);
  if (!info) {
    return { success: false, files: [] };
  }

  // Prefer TDS zip if available (pre-structured for TeX)
  let downloadUrl: string | null = null;
  let filename: string;

  if (info.install) {
    downloadUrl = `https://mirrors.ctan.org/install${info.install}`;
    filename = `${packageName}.tds.zip`;
  } else if (info.ctan?.path && info.ctan.file) {
    downloadUrl = `https://mirrors.ctan.org${info.ctan.path}.zip`;
    filename = `${packageName}.zip`;
  }

  if (!downloadUrl) {
    console.log(`  No download available for ${packageName}`);
    return { success: false, files: [] };
  }

  const zipPath = path.join(outputDir, 'downloads', filename);
  const extractDir = path.join(outputDir, 'extracted', packageName);

  // Download if not already cached
  if (!fs.existsSync(zipPath)) {
    console.log(`  Downloading: ${downloadUrl}`);
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    await downloadFile(downloadUrl, zipPath);
    const stats = fs.statSync(zipPath);
    console.log(`  Downloaded: ${(stats.size / 1024).toFixed(1)} KB`);
  } else {
    console.log(`  Using cached: ${filename}`);
  }

  // Extract
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
  } catch (e) {
    console.log(`  Warning: unzip had issues (may be ok)`);
  }

  // Find all extracted files
  const files: string[] = [];
  function walkDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }
  walkDir(extractDir);

  console.log(`  Extracted: ${files.length} files`);

  return { success: true, files };
}

interface PackageManifest {
  package: string;
  version?: string;
  files: Array<{
    source: string;      // Path in extracted dir
    target: string;      // Path in texlive tree
    size: number;
  }>;
}

function buildManifest(
  packageName: string,
  extractDir: string,
  files: string[]
): PackageManifest {
  const manifest: PackageManifest = {
    package: packageName,
    files: [],
  };

  for (const file of files) {
    const relativePath = path.relative(extractDir, file);
    const stats = fs.statSync(file);

    // TDS structure maps directly to texlive tree
    // e.g., tex/latex/pgf/... -> /texlive/texmf-dist/tex/latex/pgf/...
    let target: string;

    if (relativePath.startsWith('tex/') ||
        relativePath.startsWith('fonts/') ||
        relativePath.startsWith('doc/') ||
        relativePath.startsWith('source/') ||
        relativePath.startsWith('bibtex/') ||
        relativePath.startsWith('scripts/') ||
        relativePath.startsWith('dvips/') ||
        relativePath.startsWith('metapost/') ||
        relativePath.startsWith('metafont/')) {
      target = `/texlive/texmf-dist/${relativePath}`;
    } else if (relativePath.includes('/tex/')) {
      // Non-TDS structure, try to find tex/ subfolder
      const texIdx = relativePath.indexOf('/tex/');
      target = `/texlive/texmf-dist${relativePath.slice(texIdx)}`;
    } else if (relativePath.includes('/fonts/')) {
      const fontsIdx = relativePath.indexOf('/fonts/');
      target = `/texlive/texmf-dist${relativePath.slice(fontsIdx)}`;
    } else {
      // Skip files we can't place
      continue;
    }

    manifest.files.push({
      source: file,
      target,
      size: stats.size,
    });
  }

  return manifest;
}

async function main() {
  const outputDir = process.argv[2] || './ctan-packages';

  console.log('=== CTAN Package Downloader ===');
  console.log(`Output directory: ${outputDir}`);
  console.log(`Packages to download: ${COMMON_PACKAGES.length}\n`);

  fs.mkdirSync(outputDir, { recursive: true });

  const manifests: PackageManifest[] = [];
  const failed: string[] = [];

  for (const pkg of COMMON_PACKAGES) {
    try {
      const result = await downloadPackage(pkg, outputDir);
      if (result.success && result.files.length > 0) {
        const extractDir = path.join(outputDir, 'extracted', pkg);
        const manifest = buildManifest(pkg, extractDir, result.files);
        if (manifest.files.length > 0) {
          manifests.push(manifest);
        }
      } else {
        failed.push(pkg);
      }
    } catch (e) {
      console.log(`  ERROR: ${e}`);
      failed.push(pkg);
    }
  }

  // Write combined manifest
  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifests, null, 2));

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Successfully processed: ${manifests.length} packages`);
  console.log(`Failed: ${failed.length} packages`);
  if (failed.length > 0) {
    console.log(`Failed packages: ${failed.join(', ')}`);
  }

  // Total file count and size
  let totalFiles = 0;
  let totalSize = 0;
  for (const m of manifests) {
    totalFiles += m.files.length;
    totalSize += m.files.reduce((sum, f) => sum + f.size, 0);
  }
  console.log(`Total files: ${totalFiles}`);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

  console.log(`\nManifest written to: ${manifestPath}`);
  console.log('\nNext step: Run bundle-ctan.ts to create bundles from downloaded packages');
}

main().catch(console.error);
