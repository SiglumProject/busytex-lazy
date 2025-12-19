/**
 * LaTeX Engine Selector
 *
 * Automatically selects the optimal LaTeX engine based on document analysis,
 * historical performance data, and learned patterns.
 *
 * Design principles:
 * - Speed is the primary metric
 * - Learn from compile history
 * - Extensible for new engines and heuristics
 * - Zero configuration by default, full control when needed
 */

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompileResult {
  engine: Engine;
  success: boolean;
  timeMs: number;
  retries: number;
  fetchedPackages: string[];
  triggeredCmSuper: boolean;
}

export interface EngineStats {
  engine: Engine;
  compileCount: number;
  avgTimeMs: number;
  successRate: number;
  lastUsed: number;
}

export interface SelectionResult {
  engine: Engine;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface EngineRequirement {
  packages: Set<string>;
  commands: RegExp[];
  scripts: RegExp;
  description: string;
}

export interface EnginePreference {
  packages: Set<string>;
  description: string;
}

// Storage interface for persistence
export interface EngineStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

// Default localStorage adapter
class LocalStorageAdapter implements EngineStorageAdapter {
  private prefix = 'latex_engine_';

  async get(key: string): Promise<string | null> {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(this.prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.prefix + key, value);
  }

  async delete(key: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.prefix + key);
  }

  async keys(): Promise<string[]> {
    if (typeof localStorage === 'undefined') return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix)) {
        keys.push(key.slice(this.prefix.length));
      }
    }
    return keys;
  }
}

/**
 * Main engine selector class
 */
export class EngineSelector {
  private storage: EngineStorageAdapter;
  private requirements: Map<Engine, EngineRequirement>;
  private preferences: Map<Engine, EnginePreference>;
  private preambleCache: Map<string, EngineStats[]> = new Map();

  constructor(storage?: EngineStorageAdapter) {
    this.storage = storage || new LocalStorageAdapter();
    this.requirements = this.getDefaultRequirements();
    this.preferences = this.getDefaultPreferences();
  }

  /**
   * Define what REQUIRES a specific engine (won't work otherwise)
   */
  private getDefaultRequirements(): Map<Engine, EngineRequirement> {
    const reqs = new Map<Engine, EngineRequirement>();

    // XeLaTeX requirements - documents that won't compile with pdfLaTeX
    reqs.set('xelatex', {
      packages: new Set([
        'fontspec', 'unicode-math', 'polyglossia', 'xeCJK', 'xunicode',
        'xltxtra', 'mathspec', 'realscripts', 'metalogo', 'xetex'
      ]),
      commands: [
        /\\setmainfont\b/,
        /\\setsansfont\b/,
        /\\setmonofont\b/,
        /\\newfontfamily\b/,
        /\\setmathfont\b/,
        /\\defaultfontfeatures\b/
      ],
      // CJK, Arabic, Devanagari, Thai, Korean - scripts that need native Unicode
      scripts: /[\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3000-\u9FFF\uAC00-\uD7AF]/,
      description: 'XeLaTeX required for Unicode/OpenType features'
    });

    // LuaLaTeX requirements
    reqs.set('lualatex', {
      packages: new Set([
        'luacode', 'luatexbase', 'luaotfload', 'luamplib', 'luatextra'
      ]),
      commands: [
        /\\directlua\b/,
        /\\luaexec\b/,
        /\\luadirect\b/
      ],
      scripts: /(?!)/, // Never matches - no script requirements
      description: 'LuaLaTeX required for Lua scripting'
    });

    return reqs;
  }

  /**
   * Define what PREFERS a specific engine (works with others but better/faster)
   */
  private getDefaultPreferences(): Map<Engine, EnginePreference> {
    const prefs = new Map<Engine, EnginePreference>();

    // Packages that tend to trigger cm-super with pdfLaTeX
    // XeLaTeX handles these more cleanly with OpenType fonts
    prefs.set('xelatex', {
      packages: new Set([
        // These often trigger extended font encodings
        'geometry', 'fancyhdr', 'titlesec', 'enumitem',
        // International packages that may trigger font issues
        'babel', 'inputenc', 'fontenc'
      ]),
      description: 'XeLaTeX preferred for cleaner font handling'
    });

    return prefs;
  }

  /**
   * Add custom engine requirement
   */
  addRequirement(engine: Engine, req: Partial<EngineRequirement>): void {
    const existing = this.requirements.get(engine) || {
      packages: new Set(),
      commands: [],
      scripts: /(?!)/,
      description: ''
    };

    if (req.packages) {
      req.packages.forEach(p => existing.packages.add(p));
    }
    if (req.commands) {
      existing.commands.push(...req.commands);
    }
    if (req.scripts) {
      existing.scripts = req.scripts;
    }
    if (req.description) {
      existing.description = req.description;
    }

    this.requirements.set(engine, existing);
  }

  /**
   * Add custom engine preference
   */
  addPreference(engine: Engine, pref: Partial<EnginePreference>): void {
    const existing = this.preferences.get(engine) || {
      packages: new Set(),
      description: ''
    };

    if (pref.packages) {
      pref.packages.forEach(p => existing.packages.add(p));
    }
    if (pref.description) {
      existing.description = pref.description;
    }

    this.preferences.set(engine, existing);
  }

  /**
   * Extract preamble from LaTeX source (for hashing)
   */
  extractPreamble(source: string): string {
    const match = source.match(/^([\s\S]*?)\\begin\{document\}/);
    return match ? match[1] : source.slice(0, 2000);
  }

  /**
   * Hash preamble for cache lookup
   */
  private async hashPreamble(preamble: string): Promise<string> {
    // Normalize: remove comments, extra whitespace
    const normalized = preamble
      .replace(/%.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Simple hash function (djb2)
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return 'p_' + Math.abs(hash).toString(36);
  }

  /**
   * Extract packages from source
   */
  extractPackages(source: string): string[] {
    const packages: string[] = [];
    const regex = /\\usepackage(?:\[.*?\])?\{([^}]+)\}/g;
    let match;

    while ((match = regex.exec(source)) !== null) {
      const pkgs = match[1].split(',').map(p => p.trim());
      packages.push(...pkgs);
    }

    // Also check documentclass options and RequirePackage
    const classMatch = source.match(/\\documentclass(?:\[.*?\])?\{([^}]+)\}/);
    if (classMatch) {
      packages.push('class:' + classMatch[1]);
    }

    return packages;
  }

  /**
   * Check if source requires a specific engine
   */
  private checkRequirements(source: string, packages: string[]): SelectionResult | null {
    const withoutComments = source.replace(/%.*$/gm, '');

    for (const [engine, req] of this.requirements) {
      // Check packages
      for (const pkg of packages) {
        if (req.packages.has(pkg)) {
          return {
            engine,
            reason: `package '${pkg}' requires ${engine}`,
            confidence: 'high'
          };
        }
      }

      // Check commands
      for (const cmd of req.commands) {
        if (cmd.test(withoutComments)) {
          return {
            engine,
            reason: `command ${cmd.source} requires ${engine}`,
            confidence: 'high'
          };
        }
      }

      // Check scripts
      if (req.scripts.test(withoutComments)) {
        return {
          engine,
          reason: req.description,
          confidence: 'high'
        };
      }
    }

    return null;
  }

  /**
   * Check if source prefers a specific engine
   */
  private checkPreferences(packages: string[]): SelectionResult | null {
    for (const [engine, pref] of this.preferences) {
      for (const pkg of packages) {
        if (pref.packages.has(pkg)) {
          return {
            engine,
            reason: `package '${pkg}' - ${pref.description}`,
            confidence: 'medium'
          };
        }
      }
    }
    return null;
  }

  /**
   * Get historical stats for a preamble
   */
  private async getStats(preambleHash: string): Promise<EngineStats[] | null> {
    const data = await this.storage.get(`stats_${preambleHash}`);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Save stats for a preamble
   */
  private async saveStats(preambleHash: string, stats: EngineStats[]): Promise<void> {
    await this.storage.set(`stats_${preambleHash}`, JSON.stringify(stats));
  }

  /**
   * Main selection method
   */
  async select(source: string): Promise<SelectionResult> {
    const packages = this.extractPackages(source);
    const preamble = this.extractPreamble(source);
    const preambleHash = await this.hashPreamble(preamble);

    // 1. Check hard requirements first
    const required = this.checkRequirements(source, packages);
    if (required) {
      return required;
    }

    // 2. Check historical data for this preamble
    const stats = await this.getStats(preambleHash);
    if (stats && stats.length > 0) {
      // Find the fastest successful engine
      const successful = stats.filter(s => s.successRate > 0.5 && s.compileCount >= 2);
      if (successful.length > 0) {
        const fastest = successful.reduce((a, b) => a.avgTimeMs < b.avgTimeMs ? a : b);
        return {
          engine: fastest.engine,
          reason: `historical best: ${Math.round(fastest.avgTimeMs)}ms avg`,
          confidence: 'high'
        };
      }

      // If we have data but no good success, avoid the worst performers
      const failed = stats.filter(s => s.successRate < 0.5);
      if (failed.length > 0) {
        const failedEngines = new Set(failed.map(f => f.engine));
        const alternatives: Engine[] = ['pdflatex', 'xelatex', 'lualatex'];
        const viable = alternatives.filter(e => !failedEngines.has(e));
        if (viable.length > 0) {
          return {
            engine: viable[0],
            reason: `avoiding ${Array.from(failedEngines).join(', ')} (low success rate)`,
            confidence: 'medium'
          };
        }
      }
    }

    // 3. Check for cm-super trigger flag (learned from past failures)
    const cmSuperFlag = await this.storage.get(`cmsuper_${preambleHash}`);
    if (cmSuperFlag === 'true') {
      return {
        engine: 'xelatex',
        reason: 'preamble triggers cm-super fonts (learned)',
        confidence: 'high'
      };
    }

    // 4. Check soft preferences
    const preferred = this.checkPreferences(packages);
    if (preferred) {
      return preferred;
    }

    // 5. Default to pdflatex (fastest for simple docs)
    return {
      engine: 'pdflatex',
      reason: 'default (fastest for simple documents)',
      confidence: 'low'
    };
  }

  /**
   * Record compile result for learning
   */
  async recordResult(source: string, result: CompileResult): Promise<void> {
    const preamble = this.extractPreamble(source);
    const preambleHash = await this.hashPreamble(preamble);

    // Update stats
    let stats = await this.getStats(preambleHash) || [];
    let engineStats = stats.find(s => s.engine === result.engine);

    if (!engineStats) {
      engineStats = {
        engine: result.engine,
        compileCount: 0,
        avgTimeMs: 0,
        successRate: 0,
        lastUsed: Date.now()
      };
      stats.push(engineStats);
    }

    // Update running averages
    const n = engineStats.compileCount;
    engineStats.avgTimeMs = (engineStats.avgTimeMs * n + result.timeMs) / (n + 1);
    engineStats.successRate = (engineStats.successRate * n + (result.success ? 1 : 0)) / (n + 1);
    engineStats.compileCount++;
    engineStats.lastUsed = Date.now();

    await this.saveStats(preambleHash, stats);

    // Flag cm-super trigger for future
    if (result.triggeredCmSuper && result.engine === 'pdflatex') {
      await this.storage.set(`cmsuper_${preambleHash}`, 'true');
    }
  }

  /**
   * Clear all learned data
   */
  async clearHistory(): Promise<void> {
    const keys = await this.storage.keys();
    for (const key of keys) {
      if (key.startsWith('stats_') || key.startsWith('cmsuper_')) {
        await this.storage.delete(key);
      }
    }
    this.preambleCache.clear();
  }

  /**
   * Export learned data (for backup/transfer)
   */
  async exportData(): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};
    const keys = await this.storage.keys();
    for (const key of keys) {
      const value = await this.storage.get(key);
      if (value) {
        try {
          data[key] = JSON.parse(value);
        } catch {
          data[key] = value;
        }
      }
    }
    return data;
  }

  /**
   * Import learned data
   */
  async importData(data: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.storage.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
}

// Singleton instance for convenience
let defaultSelector: EngineSelector | null = null;

export function getEngineSelector(): EngineSelector {
  if (!defaultSelector) {
    defaultSelector = new EngineSelector();
  }
  return defaultSelector;
}

// Convenience function for simple usage
export async function selectEngine(source: string): Promise<SelectionResult> {
  return getEngineSelector().select(source);
}

export async function recordCompileResult(source: string, result: CompileResult): Promise<void> {
  return getEngineSelector().recordResult(source, result);
}
