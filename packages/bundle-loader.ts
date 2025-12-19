/**
 * Bundle Loader for Split BusyTeX Bundles
 *
 * Loads gzipped bundle files and mounts them into the Emscripten FS.
 * Bundles are loaded on-demand based on \usepackage{} requirements.
 */

interface BundleFile {
  path: string;
  name: string;
  start: number;
  end: number;
}

interface BundleMetadata {
  name: string;
  files: BundleFile[];
  totalSize: number;
}

interface BundleRegistry {
  name: string;
  files: number;
  size: number;
}

interface LoaderOptions {
  bundleBaseUrl: string;
  cacheEnabled?: boolean;
  onProgress?: (loaded: number, total: number, bundleName: string) => void;
  onLog?: (message: string) => void;
}

// Package to bundle mapping - which bundle provides which LaTeX package
const PACKAGE_TO_BUNDLE: Record<string, string[]> = {
  // Core packages included in 'core' bundle
  'article': ['core'],
  'report': ['core'],
  'book': ['core'],
  'letter': ['core'],

  // AMS packages
  'amsmath': ['amsmath', 'fonts-symbols'],
  'amssymb': ['amsmath', 'fonts-symbols'],
  'amsthm': ['amsmath'],
  'amsfonts': ['amsmath', 'fonts-symbols'],

  // Graphics packages
  'graphicx': ['graphics'],
  'graphics': ['graphics'],
  'xcolor': ['graphics'],
  'color': ['graphics'],

  // Hyperref and dependencies
  'hyperref': ['hyperref'],
  'url': ['hyperref'],

  // Babel
  'babel': ['babel'],

  // L3
  'expl3': ['l3'],
  'xparse': ['l3'],

  // Font packages
  'fontspec': ['fonts-lm-otf', 'tex-xelatex'],
  'lmodern': ['fonts-lm-tfm', 'fonts-lm-type1'],
  'mathptmx': ['fonts-misc'],
  'times': ['fonts-misc'],
  'euler': ['fonts-euler'],

  // BibTeX
  'natbib': ['bibtex'],
  'biblatex': ['bibtex'],
};

// Required bundles for different TeX engines
const ENGINE_BUNDLES: Record<string, string[]> = {
  'xetex': ['core', 'fonts-cm', 'tex-xetex', 'tex-xelatex'],
  'pdftex': ['core', 'fonts-cm', 'dvips'],
  'luatex': ['core', 'fonts-cm', 'tex-luatex', 'tex-lualatex'],
};

export class BundleLoader {
  private loadedBundles = new Set<string>();
  private bundleCache = new Map<string, ArrayBuffer>();
  private metadataCache = new Map<string, BundleMetadata>();
  private registry: BundleRegistry[] | null = null;
  private options: Required<LoaderOptions>;
  private emscriptenModule: any = null;

  constructor(options: LoaderOptions) {
    this.options = {
      cacheEnabled: true,
      onProgress: () => {},
      onLog: console.log,
      ...options,
    };
  }

  /**
   * Set the Emscripten module reference for FS operations
   */
  setEmscriptenModule(module: any): void {
    this.emscriptenModule = module;
  }

  /**
   * Load the bundle registry
   */
  async loadRegistry(): Promise<BundleRegistry[]> {
    if (this.registry) return this.registry;

    const url = `${this.options.bundleBaseUrl}/registry.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load registry from ${url}: ${response.status}`);
    }
    this.registry = await response.json();
    return this.registry!;
  }

  /**
   * Load bundle metadata
   */
  async loadMetadata(bundleName: string): Promise<BundleMetadata> {
    if (this.metadataCache.has(bundleName)) {
      return this.metadataCache.get(bundleName)!;
    }

    const url = `${this.options.bundleBaseUrl}/${bundleName}.meta.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load metadata for ${bundleName}: ${response.status}`);
    }
    const metadata: BundleMetadata = await response.json();
    this.metadataCache.set(bundleName, metadata);
    return metadata;
  }

  /**
   * Decompress gzipped data
   */
  private async decompress(compressed: ArrayBuffer): Promise<ArrayBuffer> {
    // Use DecompressionStream API if available (modern browsers)
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Response(compressed).body!
        .pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).arrayBuffer();
    }

    // Fallback: use pako if available, or throw
    if (typeof (globalThis as any).pako !== 'undefined') {
      const pako = (globalThis as any).pako;
      const decompressed = pako.inflate(new Uint8Array(compressed));
      return decompressed.buffer;
    }

    throw new Error('No decompression method available. Include pako library or use a modern browser.');
  }

  /**
   * Load and decompress a bundle's data file
   */
  async loadBundleData(bundleName: string): Promise<ArrayBuffer> {
    if (this.bundleCache.has(bundleName)) {
      return this.bundleCache.get(bundleName)!;
    }

    const url = `${this.options.bundleBaseUrl}/${bundleName}.data.gz`;

    this.options.onLog(`Loading bundle: ${bundleName}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load bundle ${bundleName}: ${response.status}`);
    }

    const compressedData = await response.arrayBuffer();
    const decompressedData = await this.decompress(compressedData);

    if (this.options.cacheEnabled) {
      this.bundleCache.set(bundleName, decompressedData);
    }

    this.options.onLog(`  Loaded ${bundleName}: ${(decompressedData.byteLength / 1024 / 1024).toFixed(2)} MB`);

    return decompressedData;
  }

  /**
   * Mount a bundle into the Emscripten filesystem
   */
  async mountBundle(bundleName: string): Promise<void> {
    if (this.loadedBundles.has(bundleName)) {
      return;
    }

    if (!this.emscriptenModule) {
      throw new Error('Emscripten module not set. Call setEmscriptenModule() first.');
    }

    const FS = this.emscriptenModule.FS;
    const [metadata, data] = await Promise.all([
      this.loadMetadata(bundleName),
      this.loadBundleData(bundleName),
    ]);

    const dataView = new Uint8Array(data);

    // Create directories and write files
    for (const file of metadata.files) {
      const fullPath = `${file.path}/${file.name}`;

      // Ensure directory exists
      this.ensureDirectory(FS, file.path);

      // Extract file data and write to FS
      const fileData = dataView.slice(file.start, file.end);

      try {
        FS.writeFile(fullPath, fileData);
      } catch (e: any) {
        // File might already exist from another bundle
        if (e.code !== 'EEXIST') {
          this.options.onLog(`Warning: Could not write ${fullPath}: ${e.message}`);
        }
      }
    }

    this.loadedBundles.add(bundleName);
    this.options.onLog(`Mounted bundle: ${bundleName} (${metadata.files.length} files)`);
  }

  /**
   * Ensure a directory path exists in the Emscripten FS
   */
  private ensureDirectory(FS: any, dirPath: string): void {
    const parts = dirPath.split('/').filter(p => p);
    let current = '';

    for (const part of parts) {
      current += '/' + part;
      try {
        FS.mkdir(current);
      } catch (e: any) {
        // Directory might already exist
        if (e.code !== 'EEXIST') {
          // Ignore other errors for now
        }
      }
    }
  }

  /**
   * Parse \usepackage{} declarations from LaTeX source
   */
  parsePackages(latex: string): string[] {
    const packages: string[] = [];

    // Match \usepackage{pkg}, \usepackage[opts]{pkg}, and \usepackage{pkg1,pkg2}
    const packageRegex = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
    let match;

    while ((match = packageRegex.exec(latex)) !== null) {
      const pkgList = match[1].split(',').map(p => p.trim());
      packages.push(...pkgList);
    }

    // Also check for \RequirePackage
    const requireRegex = /\\RequirePackage\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
    while ((match = requireRegex.exec(latex)) !== null) {
      const pkgList = match[1].split(',').map(p => p.trim());
      packages.push(...pkgList);
    }

    return [...new Set(packages)];
  }

  /**
   * Determine which bundles are needed for the given packages
   */
  resolveBundles(packages: string[]): string[] {
    const bundles = new Set<string>();

    for (const pkg of packages) {
      const requiredBundles = PACKAGE_TO_BUNDLE[pkg];
      if (requiredBundles) {
        requiredBundles.forEach(b => bundles.add(b));
      }
    }

    return [...bundles];
  }

  /**
   * Load all bundles required for a TeX engine
   */
  async loadEngineRequirements(engine: 'xetex' | 'pdftex' | 'luatex'): Promise<void> {
    const bundles = ENGINE_BUNDLES[engine] || ENGINE_BUNDLES['xetex'];
    await this.loadBundles(bundles);
  }

  /**
   * Load multiple bundles in parallel
   */
  async loadBundles(bundleNames: string[]): Promise<void> {
    const toLoad = bundleNames.filter(b => !this.loadedBundles.has(b));

    if (toLoad.length === 0) {
      return;
    }

    this.options.onLog(`Loading ${toLoad.length} bundles: ${toLoad.join(', ')}`);

    // Load metadata and data in parallel
    await Promise.all(toLoad.map(b => this.mountBundle(b)));
  }

  /**
   * Analyze LaTeX source and load required bundles
   */
  async ensurePackagesLoaded(latex: string): Promise<string[]> {
    const packages = this.parsePackages(latex);
    const bundles = this.resolveBundles(packages);

    if (bundles.length > 0) {
      await this.loadBundles(bundles);
    }

    return packages;
  }

  /**
   * Get list of loaded bundles
   */
  getLoadedBundles(): string[] {
    return [...this.loadedBundles];
  }

  /**
   * Get total loaded size
   */
  getLoadedSize(): number {
    let total = 0;
    for (const data of this.bundleCache.values()) {
      total += data.byteLength;
    }
    return total;
  }

  /**
   * Clear cached data to free memory
   */
  clearCache(): void {
    this.bundleCache.clear();
  }
}

export { PACKAGE_TO_BUNDLE, ENGINE_BUNDLES };
