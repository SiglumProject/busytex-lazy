/**
 * LaTeX Package Manager for WASM-based TeX engines
 *
 * Dynamically loads package bundles at runtime based on document requirements.
 * Works with BusyTeX, Tectonic WASM, or any Emscripten-based TeX engine.
 */

// Types
export interface BundleMetadata {
  name: string;
  version: string;
  size: number;  // bytes, compressed
  packages: string[];  // packages included in this bundle
  dependencies: string[];  // other bundles this depends on
  files: BundleFile[];
}

export interface BundleFile {
  path: string;  // virtual FS path, e.g., "/texmf/tex/latex/amsmath"
  name: string;  // filename, e.g., "amsmath.sty"
  start: number; // byte offset in .data file
  end: number;   // byte offset end
}

export interface PackageManagerConfig {
  cdnBase: string;  // e.g., "https://cdn.example.com/bundles"
  cacheVersion: string;  // bump to invalidate cache
  onProgress?: (bundle: string, loaded: number, total: number) => void;
  onBundleLoad?: (bundle: string) => void;
  FS: typeof FS;  // Emscripten filesystem
}

// Package to bundle mapping
const PACKAGE_BUNDLE_MAP: Record<string, string> = {
  // === Core (always loaded) ===
  'article': 'core',
  'book': 'core',
  'report': 'core',
  'letter': 'core',
  'latex': 'core',

  // === Math ===
  'amsmath': 'math',
  'amssymb': 'math',
  'amsthm': 'math',
  'mathtools': 'math',
  'amsfonts': 'math',
  'amscd': 'math',
  'bm': 'math',
  'mathrsfs': 'math',

  // === Graphics ===
  'graphicx': 'graphics',
  'graphics': 'graphics',
  'xcolor': 'graphics',
  'color': 'graphics',
  'float': 'graphics',
  'wrapfig': 'graphics',
  'subfig': 'graphics',
  'subcaption': 'graphics',
  'epsfig': 'graphics',

  // === TikZ/PGF (large!) ===
  'tikz': 'tikz',
  'pgf': 'tikz',
  'pgfplots': 'tikz',
  'pgfpages': 'tikz',
  'tikz-cd': 'tikz',
  'circuitikz': 'tikz',

  // === Tables ===
  'booktabs': 'tables',
  'tabularx': 'tables',
  'longtable': 'tables',
  'multirow': 'tables',
  'array': 'tables',
  'colortbl': 'tables',
  'tabu': 'tables',

  // === Bibliography ===
  'biblatex': 'bibliography',
  'natbib': 'bibliography',
  'cite': 'bibliography',
  'bibentry': 'bibliography',

  // === Fonts ===
  'fontspec': 'fonts',
  'times': 'fonts-basic',
  'helvet': 'fonts-basic',
  'courier': 'fonts-basic',
  'mathptmx': 'fonts-basic',
  'palatino': 'fonts-basic',
  'libertine': 'fonts-extra',
  'sourcecodepro': 'fonts-extra',

  // === Code Listings ===
  'listings': 'code',
  'minted': 'code',
  'verbatim': 'code',
  'fancyvrb': 'code',
  'algorithm': 'code',
  'algorithm2e': 'code',
  'algorithmicx': 'code',

  // === Beamer ===
  'beamer': 'beamer',
  'beamertheme': 'beamer',

  // === Science ===
  'siunitx': 'science',
  'physics': 'science',
  'chemfig': 'science',
  'mhchem': 'science',
  'units': 'science',

  // === Layout ===
  'geometry': 'layout',
  'fancyhdr': 'layout',
  'titlesec': 'layout',
  'titling': 'layout',
  'setspace': 'layout',
  'parskip': 'layout',
  'enumitem': 'layout',
  'multicol': 'layout',

  // === Utilities ===
  'hyperref': 'hyperref',  // own bundle due to complexity
  'url': 'hyperref',
  'bookmark': 'hyperref',
  'xparse': 'utilities',
  'etoolbox': 'utilities',
  'ifthen': 'utilities',
  'calc': 'utilities',
  'xstring': 'utilities',
  'inputenc': 'core',  // usually in core
  'fontenc': 'core',
  'babel': 'languages',
  'polyglossia': 'languages',
};

// Bundle dependencies
const BUNDLE_DEPENDENCIES: Record<string, string[]> = {
  'core': [],
  'math': ['core'],
  'graphics': ['core'],
  'tikz': ['core', 'graphics'],  // tikz needs graphics
  'tables': ['core'],
  'bibliography': ['core'],
  'fonts-basic': ['core'],
  'fonts-extra': ['core', 'fonts-basic'],
  'code': ['core'],
  'beamer': ['core', 'graphics', 'tikz'],  // beamer often uses tikz
  'science': ['core', 'math'],
  'layout': ['core'],
  'hyperref': ['core'],
  'utilities': ['core'],
  'languages': ['core'],
};

export class PackageManager {
  private config: PackageManagerConfig;
  private loadedBundles: Set<string> = new Set();
  private loadingBundles: Map<string, Promise<void>> = new Map();
  private bundleMetadata: Map<string, BundleMetadata> = new Map();
  private cache: Cache | null = null;

  constructor(config: PackageManagerConfig) {
    this.config = config;
  }

  /**
   * Initialize the package manager - call once at startup
   */
  async init(): Promise<void> {
    // Open cache
    if ('caches' in globalThis) {
      this.cache = await caches.open(`latex-packages-${this.config.cacheVersion}`);
    }

    // Load bundle registry
    await this.loadBundleRegistry();

    // Always load core bundle
    await this.loadBundle('core');
  }

  /**
   * Load the bundle registry (metadata about all available bundles)
   */
  private async loadBundleRegistry(): Promise<void> {
    const url = `${this.config.cdnBase}/registry.json`;
    const response = await this.fetchWithCache(url);
    const registry: BundleMetadata[] = await response.json();

    for (const meta of registry) {
      this.bundleMetadata.set(meta.name, meta);
    }
  }

  /**
   * Parse a LaTeX document and return required packages
   */
  parseRequiredPackages(latex: string): string[] {
    const packages: string[] = [];

    // Match \usepackage{pkg} and \usepackage[opts]{pkg}
    // Also handles \usepackage{pkg1,pkg2,pkg3}
    const usePackageRegex = /\\usepackage(?:\s*\[([^\]]*)\])?\s*\{([^}]+)\}/g;
    let match;

    while ((match = usePackageRegex.exec(latex))) {
      const pkgList = match[2];
      const pkgs = pkgList.split(',').map(p => p.trim());
      packages.push(...pkgs);
    }

    // Match \RequirePackage (used in .cls and .sty files)
    const requireRegex = /\\RequirePackage(?:\s*\[([^\]]*)\])?\s*\{([^}]+)\}/g;
    while ((match = requireRegex.exec(latex))) {
      const pkgList = match[2];
      const pkgs = pkgList.split(',').map(p => p.trim());
      packages.push(...pkgs);
    }

    // Match \documentclass
    const docClassRegex = /\\documentclass(?:\s*\[([^\]]*)\])?\s*\{([^}]+)\}/;
    const docClassMatch = docClassRegex.exec(latex);
    if (docClassMatch) {
      packages.push(docClassMatch[2].trim());

      // Beamer class implies beamer bundle
      if (docClassMatch[2].trim() === 'beamer') {
        packages.push('beamer');
      }
    }

    // Match \usetikzlibrary (implies tikz)
    if (/\\usetikzlibrary/.test(latex)) {
      packages.push('tikz');
    }

    // Match \bibliography or \addbibresource (implies bibliography)
    if (/\\bibliography\{|\\addbibresource\{/.test(latex)) {
      packages.push('biblatex');
    }

    return [...new Set(packages)]; // dedupe
  }

  /**
   * Resolve packages to bundles, including dependencies
   */
  resolveBundles(packages: string[]): string[] {
    const bundles = new Set<string>();

    for (const pkg of packages) {
      const bundle = PACKAGE_BUNDLE_MAP[pkg];
      if (bundle) {
        bundles.add(bundle);
        // Add dependencies
        this.addBundleDependencies(bundle, bundles);
      }
      // Unknown packages - they might be in core or need 'extra' bundle
    }

    // Always include core
    bundles.add('core');

    return [...bundles];
  }

  private addBundleDependencies(bundle: string, bundles: Set<string>): void {
    const deps = BUNDLE_DEPENDENCIES[bundle] || [];
    for (const dep of deps) {
      if (!bundles.has(dep)) {
        bundles.add(dep);
        this.addBundleDependencies(dep, bundles); // recursive
      }
    }
  }

  /**
   * Ensure all required bundles are loaded for a document
   */
  async ensurePackagesLoaded(latex: string): Promise<string[]> {
    const packages = this.parseRequiredPackages(latex);
    const bundles = this.resolveBundles(packages);
    const toLoad = bundles.filter(b => !this.loadedBundles.has(b));

    if (toLoad.length > 0) {
      // Load bundles in parallel
      await Promise.all(toLoad.map(b => this.loadBundle(b)));
    }

    return packages;
  }

  /**
   * Load a specific bundle
   */
  async loadBundle(name: string): Promise<void> {
    // Already loaded
    if (this.loadedBundles.has(name)) {
      return;
    }

    // Already loading (dedupe concurrent requests)
    if (this.loadingBundles.has(name)) {
      return this.loadingBundles.get(name);
    }

    const loadPromise = this._loadBundle(name);
    this.loadingBundles.set(name, loadPromise);

    try {
      await loadPromise;
      this.loadedBundles.add(name);
      this.config.onBundleLoad?.(name);
    } finally {
      this.loadingBundles.delete(name);
    }
  }

  private async _loadBundle(name: string): Promise<void> {
    // First load dependencies
    const deps = BUNDLE_DEPENDENCIES[name] || [];
    await Promise.all(deps.map(d => this.loadBundle(d)));

    // Fetch metadata
    const metaUrl = `${this.config.cdnBase}/${name}.meta.json`;
    const metaResponse = await this.fetchWithCache(metaUrl);
    const metadata: BundleMetadata = await metaResponse.json();

    // Fetch data bundle
    const dataUrl = `${this.config.cdnBase}/${name}.data`;
    const dataResponse = await this.fetchWithCache(dataUrl, (loaded, total) => {
      this.config.onProgress?.(name, loaded, total);
    });
    const dataBuffer = await dataResponse.arrayBuffer();

    // Decompress if needed (assuming LZ4)
    const data = await this.decompress(new Uint8Array(dataBuffer));

    // Mount files to Emscripten FS
    await this.mountBundle(metadata, data);
  }

  private async fetchWithCache(
    url: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Response> {
    // Check cache first
    if (this.cache) {
      const cached = await this.cache.match(url);
      if (cached) {
        return cached;
      }
    }

    // Fetch with progress
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    // Clone for caching
    const responseForCache = response.clone();

    // Track progress if reader available
    if (onProgress && response.body) {
      const reader = response.body.getReader();
      const contentLength = parseInt(response.headers.get('Content-Length') || '0');
      const chunks: Uint8Array[] = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, contentLength);
      }

      // Reconstruct response
      const blob = new Blob(chunks);
      const reconstructed = new Response(blob, {
        headers: response.headers,
        status: response.status,
      });

      // Cache it
      if (this.cache) {
        await this.cache.put(url, responseForCache);
      }

      return reconstructed;
    }

    // Cache it
    if (this.cache) {
      await this.cache.put(url, responseForCache);
    }

    return response;
  }

  private async decompress(data: Uint8Array): Promise<Uint8Array> {
    // Check for LZ4 magic bytes
    const LZ4_MAGIC = [0x04, 0x22, 0x4d, 0x18];
    const isLZ4 = data[0] === LZ4_MAGIC[0] &&
                  data[1] === LZ4_MAGIC[1] &&
                  data[2] === LZ4_MAGIC[2] &&
                  data[3] === LZ4_MAGIC[3];

    if (isLZ4) {
      // Would use lz4js or similar library
      // For now, assume uncompressed or use dynamic import
      const { decompress } = await import('lz4js');
      return decompress(data);
    }

    // Check for gzip
    if (data[0] === 0x1f && data[1] === 0x8b) {
      const ds = new DecompressionStream('gzip');
      const stream = new Response(data).body!.pipeThrough(ds);
      const decompressed = await new Response(stream).arrayBuffer();
      return new Uint8Array(decompressed);
    }

    // Uncompressed
    return data;
  }

  private async mountBundle(metadata: BundleMetadata, data: Uint8Array): Promise<void> {
    const FS = this.config.FS;

    for (const file of metadata.files) {
      // Ensure directory exists
      const dir = file.path;
      this.ensureDirectory(dir);

      // Extract file data
      const fileData = data.slice(file.start, file.end);

      // Write to virtual FS
      try {
        FS.writeFile(`${dir}/${file.name}`, fileData);
      } catch (e) {
        // File might already exist, try to unlink first
        try {
          FS.unlink(`${dir}/${file.name}`);
          FS.writeFile(`${dir}/${file.name}`, fileData);
        } catch {
          console.warn(`Failed to write ${dir}/${file.name}:`, e);
        }
      }
    }
  }

  private ensureDirectory(path: string): void {
    const FS = this.config.FS;
    const parts = path.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      current += '/' + part;
      try {
        FS.mkdir(current);
      } catch {
        // Directory already exists, ignore
      }
    }
  }

  /**
   * Get list of loaded bundles
   */
  getLoadedBundles(): string[] {
    return [...this.loadedBundles];
  }

  /**
   * Get total size of loaded bundles
   */
  getLoadedSize(): number {
    let total = 0;
    for (const name of this.loadedBundles) {
      const meta = this.bundleMetadata.get(name);
      if (meta) {
        total += meta.size;
      }
    }
    return total;
  }

  /**
   * Preload bundles for common use cases
   */
  async preloadCommon(): Promise<void> {
    // Load most common bundles in background
    const common = ['math', 'graphics', 'layout', 'hyperref'];
    await Promise.all(common.map(b => this.loadBundle(b)));
  }

  /**
   * Clear the cache (useful for debugging or updates)
   */
  async clearCache(): Promise<void> {
    if (this.cache) {
      const keys = await this.cache.keys();
      await Promise.all(keys.map(k => this.cache!.delete(k)));
    }
  }
}

// Export singleton factory
let instance: PackageManager | null = null;

export function getPackageManager(config?: PackageManagerConfig): PackageManager {
  if (!instance && config) {
    instance = new PackageManager(config);
  }
  if (!instance) {
    throw new Error('PackageManager not initialized. Call with config first.');
  }
  return instance;
}
