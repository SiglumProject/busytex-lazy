// Simple CTAN proxy server with ZIP extraction
// Run with: bun run ctan-proxy.ts

import { unzipSync } from 'fflate';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

const PORT = 8081;

// Disk cache directory
const CACHE_DIR = join(dirname(import.meta.path), 'cache');
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// Load disk cache into memory on startup
const pkgFetchCache = new Map<string, any>();
const dynamicAliasCache = new Map<string, string>();

// Load existing cache files
function loadDiskCache() {
  try {
    const cacheFiles = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    for (const file of cacheFiles) {
      const pkgName = file.replace('.json', '');
      try {
        const data = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf-8'));
        pkgFetchCache.set(pkgName, data);
      } catch (e) {
        console.warn(`Failed to load cache for ${pkgName}:`, e);
      }
    }
    console.log(`Loaded ${cacheFiles.length} packages from disk cache`);
  } catch (e) {
    console.log('No existing disk cache found');
  }

  // Load alias cache
  try {
    const aliasPath = join(CACHE_DIR, '_aliases.json');
    if (existsSync(aliasPath)) {
      const aliases = JSON.parse(readFileSync(aliasPath, 'utf-8'));
      for (const [key, value] of Object.entries(aliases)) {
        dynamicAliasCache.set(key, value as string);
      }
      console.log(`Loaded ${Object.keys(aliases).length} aliases from disk cache`);
    }
  } catch (e) {
    console.log('No alias cache found');
  }
}

// Save package to disk cache
function saveToDiskCache(pkgName: string, data: any) {
  try {
    writeFileSync(join(CACHE_DIR, `${pkgName}.json`), JSON.stringify(data));
  } catch (e) {
    console.warn(`Failed to save cache for ${pkgName}:`, e);
  }
}

// Save aliases to disk
function saveAliasCache() {
  try {
    const aliases: Record<string, string> = {};
    for (const [key, value] of dynamicAliasCache.entries()) {
      aliases[key] = value;
    }
    writeFileSync(join(CACHE_DIR, '_aliases.json'), JSON.stringify(aliases, null, 2));
  } catch (e) {
    console.warn('Failed to save alias cache:', e);
  }
}

// Load cache on startup
loadDiskCache();

// Cache for package info (CTAN metadata - small, keep in memory only)
const pkgInfoCache = new Map<string, any>();

// Minimal bootstrap aliases - only for packages where CTAN lookup itself fails
// (e.g., etex is a TeX engine, not a package - we need etex-pkg)
const bootstrapAliases: Record<string, string> = {
  'etex': 'etex-pkg',  // etex is the engine, etex-pkg is the LaTeX package
  'tikz': 'pgf',       // tikz has no CTAN entry, it's part of pgf
};

// Validate package names - filters out LaTeX macro artifacts like #2, \@tempb, %, etc.
function isValidPackageName(name: string): boolean {
  if (!name || name.length === 0) return false;
  // Must start with a letter, can contain letters, numbers, and hyphens
  // Filter out: # (macro args), \ (commands), @ (internal), % (comments), spaces
  if (/^[a-zA-Z][a-zA-Z0-9\-]*$/.test(name)) {
    return true;
  }
  return false;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,  // 2 minutes for large packages like cm-super
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Route: /api/pkg/:name - Get package info from CTAN
    if (url.pathname.startsWith('/api/pkg/')) {
      const pkgName = url.pathname.replace('/api/pkg/', '');
      try {
        const info = await getCTANPackageInfo(pkgName);
        return new Response(JSON.stringify(info || { error: 'Not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Route: /api/deps/:name - Get package dependencies recursively
    if (url.pathname.startsWith('/api/deps/')) {
      const pkgName = url.pathname.replace('/api/deps/', '');
      try {
        const deps = await getPackageDependencies(pkgName);
        return new Response(JSON.stringify({ package: pkgName, dependencies: deps }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Route: /api/fetch/:name - Download, extract, and return package files
    if (url.pathname.startsWith('/api/fetch/')) {
      const requestedPkg = url.pathname.replace('/api/fetch/', '');

      // Check bootstrap aliases first (minimal hardcoded list for edge cases)
      let pkgName = bootstrapAliases[requestedPkg] || dynamicAliasCache.get(requestedPkg) || requestedPkg;

      // Check cache first
      if (pkgFetchCache.has(pkgName)) {
        console.log(`Cache hit: ${requestedPkg}${pkgName !== requestedPkg ? ` (via ${pkgName})` : ''}`);
        return new Response(JSON.stringify(pkgFetchCache.get(pkgName)), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      try {
        console.log(`Fetching package: ${requestedPkg}${pkgName !== requestedPkg ? ` (via ${pkgName})` : ''}`);

        // Try TexLive archive first (has pre-built .sty files)
        const tlUrl = `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2023/tlnet-final/archive/${pkgName}.tar.xz`;
        console.log(`  Trying TexLive: ${tlUrl}`);
        const tlResponse = await fetch(tlUrl, { redirect: 'follow' });

        if (tlResponse.ok) {
          const tarData = new Uint8Array(await tlResponse.arrayBuffer());
          return await processTexLiveTar(tarData, pkgName, corsHeaders);
        }

        // TexLive not found - query CTAN to find the parent package
        console.log(`  TexLive not found, querying CTAN for package info...`);
        const infoResponse = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`);
        const info = await infoResponse.json();

        if (info.errors) {
          // CTAN doesn't know this package - check if any cached package contains a file with this name
          console.log(`  CTAN doesn't know ${pkgName}, searching cached packages...`);
          for (const [cachedPkgName, cachedData] of pkgFetchCache.entries()) {
            const files = cachedData.files || {};
            for (const filePath of Object.keys(files)) {
              const fileName = filePath.split('/').pop()?.replace(/\.(sty|tex|cls|def)$/, '') || '';
              if (fileName === pkgName) {
                console.log(`  Found ${pkgName} in cached package ${cachedPkgName}`);
                dynamicAliasCache.set(pkgName, cachedPkgName);
                saveAliasCache();
                return new Response(JSON.stringify(cachedData), {
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
              }
            }
          }
          // Not found anywhere
          console.log(`  ${pkgName} not found in any source`);
          return new Response(JSON.stringify({ error: 'Package not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Check if CTAN tells us this is part of a different package (miktex or texlive field)
        const parentPkg = info.miktex || info.texlive;
        if (parentPkg && parentPkg !== pkgName) {
          console.log(`  CTAN says ${pkgName} is part of ${parentPkg}`);
          // Cache this mapping for future requests
          dynamicAliasCache.set(requestedPkg, parentPkg);
          if (pkgName !== requestedPkg) {
            dynamicAliasCache.set(pkgName, parentPkg);
          }
          saveAliasCache();

          // Check if we already have the parent cached
          if (pkgFetchCache.has(parentPkg)) {
            console.log(`  Cache hit for parent: ${parentPkg}`);
            return new Response(JSON.stringify(pkgFetchCache.get(parentPkg)), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          // Try to fetch the parent package from TexLive
          const parentTlUrl = `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2023/tlnet-final/archive/${parentPkg}.tar.xz`;
          console.log(`  Trying TexLive for parent: ${parentTlUrl}`);
          const parentTlResponse = await fetch(parentTlUrl, { redirect: 'follow' });
          if (parentTlResponse.ok) {
            const tarData = new Uint8Array(await parentTlResponse.arrayBuffer());
            return await processTexLiveTar(tarData, parentPkg, corsHeaders);
          }

          // Update pkgName for CTAN fallback
          pkgName = parentPkg;
        }

        // Fall back to CTAN download
        console.log(`  Trying CTAN download...`);

        // Determine download URL
        let downloadUrl: string | null = null;
        if (info.install) {
          downloadUrl = `https://mirrors.ctan.org/install${info.install}`;
        } else if (info.ctan?.path) {
          // Try TDS zip first, fall back to source
          downloadUrl = `https://mirrors.ctan.org${info.ctan.path}.zip`;
        }

        if (!downloadUrl) {
          return new Response(JSON.stringify({ error: 'No download URL available' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        console.log(`  Downloading: ${downloadUrl}`);
        const zipResponse = await fetch(downloadUrl, { redirect: 'follow' });

        if (!zipResponse.ok) {
          // Try alternate URL format
          if (info.ctan?.path && !downloadUrl.includes('/install/')) {
            const altUrl = `https://mirrors.ctan.org${info.ctan.path}/${pkgName}.zip`;
            console.log(`  Trying alternate: ${altUrl}`);
            const altResponse = await fetch(altUrl, { redirect: 'follow' });
            if (altResponse.ok) {
              const zipData = new Uint8Array(await altResponse.arrayBuffer());
              return processZip(zipData, pkgName, corsHeaders);
            }
          }
          return new Response(JSON.stringify({ error: `Download failed: ${zipResponse.status}` }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const zipData = new Uint8Array(await zipResponse.arrayBuffer());
        return processZip(zipData, pkgName, corsHeaders);

      } catch (e: any) {
        console.error(`Error fetching ${pkgName}:`, e);
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('CTAN Proxy Server\n\nEndpoints:\n  /api/pkg/:name - Get package info\n  /api/fetch/:name - Download and extract package', {
      headers: corsHeaders
    });
  }
});

function processZip(zipData: Uint8Array, pkgName: string, corsHeaders: Record<string, string>) {
  try {
    console.log(`  Extracting ZIP (${(zipData.length / 1024).toFixed(1)} KB)`);
    const files = unzipSync(zipData);

    // Find TeX files and font files
    const result: Record<string, { path: string; content: string | Uint8Array }> = {};
    const texExtensions = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo'];
    // Font-related extensions (Type1, TFM, map files)
    const fontExtensions = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
    const detectedDeps = new Set<string>();

    for (const [filePath, content] of Object.entries(files)) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const fileName = filePath.split('/').pop() || '';

      // Skip source files, docs, etc
      if (filePath.includes('/doc/') || filePath.includes('/source/')) continue;

      if (texExtensions.includes(ext)) {
        // Determine target path
        let targetDir = `/texlive/texmf-dist/tex/latex/${pkgName}`;

        // If it's a TDS zip, preserve structure
        if (filePath.includes('/tex/latex/')) {
          const match = filePath.match(/\/tex\/latex\/([^/]+)/);
          if (match) {
            targetDir = `/texlive/texmf-dist/tex/latex/${match[1]}`;
          }
        } else if (filePath.includes('/tex/generic/')) {
          const match = filePath.match(/\/tex\/generic\/([^/]+)/);
          if (match) {
            targetDir = `/texlive/texmf-dist/tex/generic/${match[1]}`;
          }
        }

        const textContent = new TextDecoder().decode(content);
        result[`${targetDir}/${fileName}`] = {
          path: targetDir,
          content: textContent
        };

        // Scan for \RequirePackage dependencies
        const reqMatches = textContent.matchAll(/\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g);
        for (const match of reqMatches) {
          const deps = match[1].split(',').map(d => d.trim());
          deps.filter(d => isValidPackageName(d)).forEach(d => detectedDeps.add(d));
        }
      } else if (fontExtensions.includes(ext)) {
        // Font files - preserve TDS path structure
        // Match any /fonts/... path and preserve it
        const fontsMatch = filePath.match(/\/(fonts\/[^/]+(?:\/[^/]+)*)\//);
        let targetDir: string;

        if (fontsMatch) {
          // Preserve the TDS structure: fonts/type1/public/cm-super -> /texlive/texmf-dist/fonts/type1/public/cm-super
          const fontsPath = fontsMatch[1];
          const afterFonts = filePath.substring(filePath.indexOf(fontsMatch[0]) + fontsMatch[0].length);
          const dirParts = afterFonts.split('/');
          dirParts.pop(); // Remove filename
          const subPath = dirParts.join('/');
          targetDir = `/texlive/texmf-dist/${fontsPath}${subPath ? '/' + subPath : ''}`;
        } else {
          // Fallback for fonts without TDS structure
          targetDir = `/texlive/texmf-dist/fonts/type1/public/${pkgName}`;
        }

        // For binary font files, encode as base64 to reduce JSON size
        // Mark with _base64 suffix so client knows to decode
        const base64Content = Buffer.from(content).toString('base64');
        result[`${targetDir}/${fileName}`] = {
          path: targetDir,
          content: base64Content,
          encoding: 'base64'
        };
      }
    }

    const fileCount = Object.keys(result).length;
    const dependencies = [...detectedDeps].filter(d => d !== pkgName);
    console.log(`  Extracted ${fileCount} files, detected deps: ${dependencies.join(', ') || 'none'}`);

    if (fileCount === 0) {
      return new Response(JSON.stringify({ error: 'No usable files found in package' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const responseData = {
      name: pkgName,
      files: result,
      totalFiles: fileCount,
      dependencies
    };
    // Cache the result in memory and on disk
    pkgFetchCache.set(pkgName, responseData);
    saveToDiskCache(pkgName, responseData);

    return new Response(JSON.stringify(responseData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e: any) {
    console.error(`  ZIP extraction error:`, e);
    return new Response(JSON.stringify({ error: `ZIP extraction failed: ${e.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Process TexLive .tar.xz archive
async function processTexLiveTar(tarData: Uint8Array, pkgName: string, corsHeaders: Record<string, string>) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'texlive-'));
  try {
    console.log(`  Extracting TexLive tar.xz (${(tarData.length / 1024).toFixed(1)} KB)`);

    // Write tar.xz to temp file and extract with system tar
    const tarPath = join(tmpDir, `${pkgName}.tar.xz`);
    writeFileSync(tarPath, tarData);
    execSync(`tar xJf "${tarPath}" -C "${tmpDir}"`, { stdio: 'pipe' });

    // Find TeX files and font files
    const result: Record<string, { path: string; content: string | Uint8Array }> = {};
    const texExtensions = ['.sty', '.cls', '.def', '.cfg', '.tex', '.fd', '.clo'];
    // Font-related extensions (Type1, TFM, map files)
    const fontExtensions = ['.pfb', '.pfm', '.afm', '.tfm', '.vf', '.map', '.enc'];
    const detectedDeps = new Set<string>();

    function walkDir(dir: string) {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else {
          const ext = entry.substring(entry.lastIndexOf('.')).toLowerCase();
          // Skip doc and source directories
          if (fullPath.includes('/doc/') || fullPath.includes('/source/')) continue;

          const relPath = fullPath.replace(tmpDir + '/', '');

          if (texExtensions.includes(ext)) {
            // Determine target path - preserve TDS structure
            let targetDir = `/texlive/texmf-dist/tex/latex/${pkgName}`;

            if (relPath.includes('/tex/latex/')) {
              const match = relPath.match(/\/tex\/latex\/([^/]+)/);
              if (match) targetDir = `/texlive/texmf-dist/tex/latex/${match[1]}`;
            } else if (relPath.includes('/tex/generic/')) {
              const match = relPath.match(/\/tex\/generic\/([^/]+)/);
              if (match) targetDir = `/texlive/texmf-dist/tex/generic/${match[1]}`;
            }

            const textContent = readFileSync(fullPath, 'utf-8');
            result[`${targetDir}/${entry}`] = {
              path: targetDir,
              content: textContent
            };

            // Scan for \RequirePackage dependencies
            const reqMatches = textContent.matchAll(/\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g);
            for (const match of reqMatches) {
              const deps = match[1].split(',').map(d => d.trim());
              deps.filter(d => isValidPackageName(d)).forEach(d => detectedDeps.add(d));
            }
          } else if (fontExtensions.includes(ext)) {
            // Font files - preserve TDS path structure
            const fontsMatch = relPath.match(/\/(fonts\/[^/]+(?:\/[^/]+)*)\//);
            let targetDir: string;

            if (fontsMatch) {
              // Preserve the TDS structure from the archive
              const fontsPath = fontsMatch[1];
              const afterFonts = relPath.substring(relPath.indexOf(fontsMatch[0]) + fontsMatch[0].length);
              const dirParts = afterFonts.split('/');
              dirParts.pop(); // Remove filename
              const subPath = dirParts.join('/');
              targetDir = `/texlive/texmf-dist/${fontsPath}${subPath ? '/' + subPath : ''}`;
            } else {
              targetDir = `/texlive/texmf-dist/fonts/type1/public/${pkgName}`;
            }

            // Read binary font files and encode as base64
            const binaryContent = readFileSync(fullPath);
            const base64Content = binaryContent.toString('base64');
            result[`${targetDir}/${entry}`] = {
              path: targetDir,
              content: base64Content,
              encoding: 'base64'
            };
          }
        }
      }
    }

    walkDir(tmpDir);

    const fileCount = Object.keys(result).length;
    const dependencies = [...detectedDeps].filter(d => d !== pkgName);
    console.log(`  Extracted ${fileCount} files from TexLive, deps: ${dependencies.join(', ') || 'none'}`);

    if (fileCount === 0) {
      return new Response(JSON.stringify({ error: 'No usable files found in package' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const responseData = {
      name: pkgName,
      files: result,
      totalFiles: fileCount,
      dependencies,
      source: 'texlive'
    };
    // Cache the result in memory and on disk
    pkgFetchCache.set(pkgName, responseData);
    saveToDiskCache(pkgName, responseData);

    return new Response(JSON.stringify(responseData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e: any) {
    console.error(`  TexLive tar extraction error:`, e);
    return new Response(JSON.stringify({ error: `TexLive extraction failed: ${e.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } finally {
    // Cleanup
    try { rmSync(tmpDir, { recursive: true }); } catch (e) {}
  }
}

// Get package info from CTAN (cached)
async function getCTANPackageInfo(pkgName: string): Promise<any> {
  if (pkgInfoCache.has(pkgName)) {
    return pkgInfoCache.get(pkgName);
  }

  try {
    const response = await fetch(`https://ctan.org/json/2.0/pkg/${pkgName}`);
    if (!response.ok) return null;
    const info = await response.json();
    if (info.errors) return null;
    pkgInfoCache.set(pkgName, info);
    return info;
  } catch (e) {
    return null;
  }
}

// Get package dependencies recursively from CTAN
async function getPackageDependencies(pkgName: string, visited = new Set<string>()): Promise<string[]> {
  if (visited.has(pkgName)) return [];
  visited.add(pkgName);

  const info = await getCTANPackageInfo(pkgName);
  if (!info) return [];

  const deps: string[] = [];

  // CTAN packages can have keyval "also" field with related packages
  // and "depends" for actual dependencies
  if (info.depends) {
    for (const dep of info.depends) {
      if (typeof dep === 'string' && !visited.has(dep)) {
        deps.push(dep);
        // Recursively get dependencies
        const subDeps = await getPackageDependencies(dep, visited);
        deps.push(...subDeps);
      } else if (dep.name && !visited.has(dep.name)) {
        deps.push(dep.name);
        const subDeps = await getPackageDependencies(dep.name, visited);
        deps.push(...subDeps);
      }
    }
  }

  return [...new Set(deps)];
}

console.log(`CTAN Proxy running on http://localhost:${PORT}`);
