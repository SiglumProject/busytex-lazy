#!/usr/bin/env ts-node
/**
 * Bundle Builder
 *
 * Creates .data bundles from TeX Live packages for use with the PackageManager.
 * Run this offline to generate bundles, then upload to CDN.
 *
 * Usage:
 *   npx ts-node bundle-builder.ts --bundle math --output ./dist/bundles
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';

interface BundleConfig {
  name: string;
  packages: string[];
  dependencies: string[];
}

interface BundleFile {
  path: string;
  name: string;
  start: number;
  end: number;
}

interface BundleMetadata {
  name: string;
  version: string;
  size: number;
  sizeUncompressed: number;
  packages: string[];
  dependencies: string[];
  files: BundleFile[];
  hash: string;
}

// Bundle definitions
const BUNDLE_CONFIGS: BundleConfig[] = [
  {
    name: 'core',
    packages: [
      'latex-base',
      'latex-fonts',
      'article',
      'book',
      'report',
      'letter',
      'inputenc',
      'fontenc',
    ],
    dependencies: [],
  },
  {
    name: 'math',
    packages: [
      'amsmath',
      'amscls',
      'amsfonts',
      'mathtools',
      'bm',
    ],
    dependencies: ['core'],
  },
  {
    name: 'graphics',
    packages: [
      'graphics',
      'graphics-def',
      'xcolor',
      'float',
      'wrapfig',
      'subfig',
    ],
    dependencies: ['core'],
  },
  {
    name: 'tikz',
    packages: [
      'pgf',
      'tikz-cd',
      'pgfplots',
    ],
    dependencies: ['core', 'graphics'],
  },
  {
    name: 'tables',
    packages: [
      'booktabs',
      'tabularx',
      'longtable',
      'multirow',
      'array',
    ],
    dependencies: ['core'],
  },
  {
    name: 'bibliography',
    packages: [
      'biblatex',
      'biber',
      'natbib',
      'cite',
    ],
    dependencies: ['core'],
  },
  {
    name: 'fonts-basic',
    packages: [
      'times',
      'helvetic',
      'courier',
      'mathptmx',
      'palatino',
    ],
    dependencies: ['core'],
  },
  {
    name: 'code',
    packages: [
      'listings',
      'fancyvrb',
      'algorithms',
    ],
    dependencies: ['core'],
  },
  {
    name: 'beamer',
    packages: [
      'beamer',
      'beamertheme-metropolis',
    ],
    dependencies: ['core', 'graphics', 'tikz'],
  },
  {
    name: 'science',
    packages: [
      'siunitx',
      'physics',
      'mhchem',
    ],
    dependencies: ['core', 'math'],
  },
  {
    name: 'layout',
    packages: [
      'geometry',
      'fancyhdr',
      'titlesec',
      'setspace',
      'parskip',
      'enumitem',
      'multicol',
    ],
    dependencies: ['core'],
  },
  {
    name: 'hyperref',
    packages: [
      'hyperref',
      'url',
      'bookmark',
    ],
    dependencies: ['core'],
  },
  {
    name: 'utilities',
    packages: [
      'xparse',
      'l3kernel',
      'l3packages',
      'etoolbox',
      'ifthen',
      'calc',
      'xstring',
    ],
    dependencies: ['core'],
  },
];

class BundleBuilder {
  private texmfRoot: string;
  private outputDir: string;
  private compress: boolean;

  constructor(texmfRoot: string, outputDir: string, compress = true) {
    this.texmfRoot = texmfRoot;
    this.outputDir = outputDir;
    this.compress = compress;
  }

  /**
   * Find all files belonging to a package
   */
  private findPackageFiles(packageName: string): string[] {
    const files: string[] = [];
    const searchDirs = [
      path.join(this.texmfRoot, 'tex', 'latex', packageName),
      path.join(this.texmfRoot, 'tex', 'generic', packageName),
      path.join(this.texmfRoot, 'fonts', 'tfm', packageName),
      path.join(this.texmfRoot, 'fonts', 'type1', packageName),
      path.join(this.texmfRoot, 'fonts', 'opentype', packageName),
    ];

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        this.walkDir(dir, files);
      }
    }

    // Also check for .sty file directly in latex folder
    const styFile = path.join(this.texmfRoot, 'tex', 'latex', `${packageName}.sty`);
    if (fs.existsSync(styFile)) {
      files.push(styFile);
    }

    return files;
  }

  private walkDir(dir: string, files: string[]): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(fullPath, files);
      } else {
        files.push(fullPath);
      }
    }
  }

  /**
   * Build a single bundle
   */
  async buildBundle(config: BundleConfig): Promise<BundleMetadata> {
    console.log(`Building bundle: ${config.name}`);

    // Collect all files
    const allFiles: string[] = [];
    for (const pkg of config.packages) {
      const pkgFiles = this.findPackageFiles(pkg);
      allFiles.push(...pkgFiles);
      console.log(`  ${pkg}: ${pkgFiles.length} files`);
    }

    if (allFiles.length === 0) {
      console.warn(`  Warning: No files found for bundle ${config.name}`);
    }

    // Build data buffer
    const chunks: Buffer[] = [];
    const fileMetadata: BundleFile[] = [];
    let offset = 0;

    for (const file of allFiles) {
      const content = fs.readFileSync(file);
      const relativePath = path.relative(this.texmfRoot, path.dirname(file));
      const virtualPath = '/texmf/' + relativePath;

      fileMetadata.push({
        path: virtualPath,
        name: path.basename(file),
        start: offset,
        end: offset + content.length,
      });

      chunks.push(content);
      offset += content.length;
    }

    // Concatenate all file contents
    const dataBuffer = Buffer.concat(chunks);
    const hash = createHash('sha256').update(dataBuffer).digest('hex').slice(0, 16);

    // Compress
    let finalBuffer: Buffer;
    if (this.compress) {
      finalBuffer = zlib.gzipSync(dataBuffer, { level: 9 });
    } else {
      finalBuffer = dataBuffer;
    }

    // Write data file
    const dataPath = path.join(this.outputDir, `${config.name}.data`);
    fs.writeFileSync(dataPath, finalBuffer);

    // Create metadata
    const metadata: BundleMetadata = {
      name: config.name,
      version: new Date().toISOString().split('T')[0], // YYYY-MM-DD
      size: finalBuffer.length,
      sizeUncompressed: dataBuffer.length,
      packages: config.packages,
      dependencies: config.dependencies,
      files: fileMetadata,
      hash,
    };

    // Write metadata file
    const metaPath = path.join(this.outputDir, `${config.name}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

    console.log(`  Output: ${dataPath} (${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    return metadata;
  }

  /**
   * Build all bundles and generate registry
   */
  async buildAll(): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true });

    const allMetadata: BundleMetadata[] = [];

    for (const config of BUNDLE_CONFIGS) {
      const metadata = await this.buildBundle(config);
      allMetadata.push(metadata);
    }

    // Write registry
    const registryPath = path.join(this.outputDir, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(allMetadata, null, 2));
    console.log(`\nRegistry written to: ${registryPath}`);

    // Print summary
    console.log('\n=== Bundle Summary ===');
    let totalSize = 0;
    for (const meta of allMetadata) {
      console.log(`${meta.name.padEnd(15)} ${(meta.size / 1024 / 1024).toFixed(2).padStart(8)} MB  (${meta.files.length} files)`);
      totalSize += meta.size;
    }
    console.log(`${'TOTAL'.padEnd(15)} ${(totalSize / 1024 / 1024).toFixed(2).padStart(8)} MB`);
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  // Parse args
  let texmfRoot = '/usr/local/texlive/2024/texmf-dist'; // default
  let outputDir = './dist/bundles';
  let singleBundle: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--texmf' && args[i + 1]) {
      texmfRoot = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === '--bundle' && args[i + 1]) {
      singleBundle = args[++i];
    } else if (args[i] === '--help') {
      console.log(`
Usage: bundle-builder.ts [options]

Options:
  --texmf <path>    Path to texmf-dist directory (default: /usr/local/texlive/2024/texmf-dist)
  --output <path>   Output directory for bundles (default: ./dist/bundles)
  --bundle <name>   Build only a specific bundle
  --help            Show this help

Examples:
  # Build all bundles
  npx ts-node bundle-builder.ts --texmf /usr/share/texlive/texmf-dist --output ./bundles

  # Build only the math bundle
  npx ts-node bundle-builder.ts --bundle math --output ./bundles
`);
      process.exit(0);
    }
  }

  const builder = new BundleBuilder(texmfRoot, outputDir);

  if (singleBundle) {
    const config = BUNDLE_CONFIGS.find(c => c.name === singleBundle);
    if (!config) {
      console.error(`Unknown bundle: ${singleBundle}`);
      console.error(`Available bundles: ${BUNDLE_CONFIGS.map(c => c.name).join(', ')}`);
      process.exit(1);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    await builder.buildBundle(config);
  } else {
    await builder.buildAll();
  }
}

main().catch(console.error);
