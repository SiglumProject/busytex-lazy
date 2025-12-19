/**
 * BusyTeX Integration with Split Bundle Loading
 *
 * This integrates the BundleLoader with BusyTeX to enable on-demand
 * loading of TeX packages from split bundles.
 */

import { BundleLoader } from './bundle-loader';

interface CompileOptions {
  mainFile: string;
  bibtex?: boolean;
  verbose?: 'silent' | 'info' | 'debug';
  driver?: 'xetex_bibtex8_dvipdfmx' | 'pdftex_bibtex8';
}

interface CompileResult {
  pdf: Uint8Array | null;
  log: string;
  success: boolean;
}

/**
 * BusyTeX Pipeline with Split Bundle Support
 */
export class SplitBundlePipeline {
  private loader: BundleLoader;
  private busytexModule: any = null;
  private initialized = false;
  private logs: string[] = [];

  constructor(
    private bundleBaseUrl: string,
    private busytexJsUrl: string,
    private busytexWasmUrl: string,
    private onLog?: (msg: string) => void
  ) {
    this.loader = new BundleLoader({
      bundleBaseUrl,
      onLog: (msg) => {
        this.logs.push(msg);
        this.onLog?.(msg);
      },
    });
  }

  private log(msg: string): void {
    this.logs.push(msg);
    this.onLog?.(msg);
  }

  /**
   * Initialize the BusyTeX WASM module
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.log('Initializing BusyTeX WASM module...');

    // Load the BusyTeX JavaScript
    const script = document.createElement('script');
    script.src = this.busytexJsUrl;

    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load busytex.js'));
      document.head.appendChild(script);
    });

    // Initialize the module with custom locateFile for WASM
    const moduleConfig = {
      locateFile: (path: string) => {
        if (path.endsWith('.wasm')) {
          return this.busytexWasmUrl;
        }
        return path;
      },
      print: (text: string) => this.log(text),
      printErr: (text: string) => this.log(`[stderr] ${text}`),
    };

    // @ts-ignore - BusyTeX creates this global
    this.busytexModule = await (globalThis as any).BusyTeX(moduleConfig);

    // Connect the loader to the module's FS
    this.loader.setEmscriptenModule(this.busytexModule);

    // Load core bundle (required for basic operation)
    this.log('Loading core bundle...');
    await this.loader.mountBundle('core');

    this.initialized = true;
    this.log('BusyTeX initialized successfully');
  }

  /**
   * Compile a LaTeX document
   */
  async compile(
    files: Array<{ path: string; contents: string }>,
    options: CompileOptions
  ): Promise<CompileResult> {
    if (!this.initialized) {
      await this.init();
    }

    this.logs = [];
    const FS = this.busytexModule.FS;

    // Analyze main file and load required packages
    const mainContent = files.find(f => f.path === options.mainFile)?.contents || '';
    this.log('Analyzing package requirements...');
    const packages = await this.loader.ensurePackagesLoaded(mainContent);
    if (packages.length > 0) {
      this.log(`Detected packages: ${packages.join(', ')}`);
    }

    // Load engine-specific bundles
    const engine = options.driver?.startsWith('xetex') ? 'xetex' :
                   options.driver?.startsWith('pdftex') ? 'pdftex' : 'xetex';
    await this.loader.loadEngineRequirements(engine);

    // Write input files to FS
    for (const file of files) {
      const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
      if (dir && dir !== '.') {
        this.ensureDir(FS, dir);
      }
      FS.writeFile(file.path, file.contents);
    }

    try {
      // Run TeX compilation
      const result = this.runTeX(options);
      return result;
    } catch (e: any) {
      return {
        pdf: null,
        log: this.logs.join('\n') + '\n' + e.message,
        success: false,
      };
    }
  }

  private ensureDir(FS: any, path: string): void {
    const parts = path.split('/').filter(p => p);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      try { FS.mkdir(current); } catch (e) {}
    }
  }

  private runTeX(options: CompileOptions): CompileResult {
    const FS = this.busytexModule.FS;
    const mainFile = options.mainFile;
    const baseName = mainFile.replace(/\.tex$/, '');

    // Run XeTeX
    this.log(`Running xetex on ${mainFile}...`);
    const xetexArgs = [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-output-driver=xdvipdfmx',
      mainFile,
    ];

    try {
      this.busytexModule.callMain(['xetex', ...xetexArgs]);
    } catch (e: any) {
      this.log(`XeTeX error: ${e.message}`);
    }

    // Check for PDF output
    let pdfData: Uint8Array | null = null;
    const pdfPath = `${baseName}.pdf`;

    try {
      pdfData = FS.readFile(pdfPath);
      this.log(`PDF generated: ${pdfPath} (${(pdfData.length / 1024).toFixed(1)} KB)`);
    } catch (e) {
      // Try XDV + dvipdfmx if direct PDF not available
      const xdvPath = `${baseName}.xdv`;
      try {
        FS.readFile(xdvPath);
        this.log('Running dvipdfmx...');
        this.busytexModule.callMain(['xdvipdfmx', '-o', pdfPath, xdvPath]);
        pdfData = FS.readFile(pdfPath);
        this.log(`PDF generated via dvipdfmx: ${pdfPath}`);
      } catch (e2) {
        this.log('No PDF or XDV output found');
      }
    }

    // Read log file
    let logContent = '';
    try {
      logContent = new TextDecoder().decode(FS.readFile(`${baseName}.log`));
    } catch (e) {}

    return {
      pdf: pdfData,
      log: this.logs.join('\n') + '\n' + logContent,
      success: pdfData !== null && pdfData.length > 0,
    };
  }

  /**
   * Get loaded bundle statistics
   */
  getStats(): { bundles: string[]; totalSize: number } {
    return {
      bundles: this.loader.getLoadedBundles(),
      totalSize: this.loader.getLoadedSize(),
    };
  }

  /**
   * Preload specific bundles
   */
  async preloadBundles(bundleNames: string[]): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    await this.loader.loadBundles(bundleNames);
  }
}
