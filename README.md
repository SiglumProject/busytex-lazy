# busytex-lazy

A lazy-loading infrastructure layer for [BusyTeX](https://github.com/busytex/busytex), enabling browser-based LaTeX compilation without downloading the entire TeX Live distribution upfront.

## The Problem

TeX Live is massive. A minimal pdflatex installation is 100MB+, and supporting common packages pushes it to 500MB+. Loading this upfront makes browser-based LaTeX impractical for most use cases.

## The Solution

**busytex-lazy** splits TeX Live into small bundles (~1-10MB each) that are loaded on-demand during compilation:

1. **Initial load**: Only core bundles (~15MB compressed) for basic documents
2. **On-demand loading**: Additional packages fetched as the document requires them
3. **CTAN fallback**: Missing packages automatically downloaded from CTAN mirrors
4. **Persistent caching**: OPFS/IndexedDB storage eliminates repeat downloads

## Prerequisites

This project uses [BusyTeX](https://github.com/busytex/busytex) as a git submodule. After cloning, you need to build or download the WASM files:

```bash
# Clone with submodules
git clone --recurse-submodules <repo-url>

# Build BusyTeX (requires emscripten)
cd busytex
make wasm
cp build/wasm/busytex.js build/wasm/busytex.wasm ..
cd ..
```

Or download pre-built binaries from the [BusyTeX releases](https://github.com/busytex/busytex/releases).

## Quick Start

```bash
# Start a local server
python3 -m http.server 8080

# Open in browser
open http://localhost:8080/split-bundle-lazy.html
```

The demo page includes a full-featured editor with:
- Engine selection (pdflatex, xelatex, lualatex)
- Custom format generation (pre-compile preambles for faster subsequent compiles)
- PDF preview
- Automatic CTAN package fetching

## Bundle System

Bundles are pre-packaged collections of TeX files:

| Bundle | Contents | Size (gzip) |
|--------|----------|-------------|
| `core` | LaTeX kernel, base classes | ~2MB |
| `fmt-pdflatex` | pdflatex format file | ~3MB |
| `l3` | LaTeX3 packages (expl3, xparse) | ~2MB |
| `fonts-cm` | Computer Modern fonts | ~1MB |
| `amsmath` | AMS math packages | ~500KB |
| `graphics` | graphicx, color, etc. | ~300KB |
| `tikz` | TikZ/PGF graphics | ~5MB |
| ... | 30+ more bundles | varies |

### Bundle Structure

```
packages/bundles/
├── core.data.gz          # Compressed file contents
├── core.meta.json        # File paths, offsets, sizes
├── amsmath.data.gz
├── amsmath.meta.json
├── registry.json         # Available bundles
├── package-map.json      # Package name -> bundle mapping
├── file-manifest.json    # File path -> bundle mapping
└── bundle-deps.json      # Bundle dependency graph
```

## CTAN Fallback

When a package isn't in any bundle, busytex-lazy fetches it from CTAN:

1. Compilation fails with "file not found"
2. System extracts package name from the missing file path
3. CTAN API queried for package metadata
4. Package files downloaded and mounted
5. Compilation retried automatically

This provides access to all 6000+ CTAN packages without bundling them.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Main Thread   │     │  Compile Worker │
├─────────────────┤     ├─────────────────┤
│ - UI updates    │────▶│ - WASM runtime  │
│ - OPFS caching  │     │ - Bundle mount  │
│ - Bundle fetch  │◀────│ - Compilation   │
│ - PDF render    │     │ - Font handling │
└─────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Storage Layer  │
├─────────────────┤
│ - OPFS (fast)   │
│ - IndexedDB     │
│ - Fetch cache   │
└─────────────────┘
```

## Engine Support

| Engine | Status | Notes |
|--------|--------|-------|
| pdflatex | Working | Primary focus |
| xelatex | Working | Requires OTF font bundles |
| lualatex | Partial | Large format files |

## Known Limitations

- **kpathsea quirks**: Font path resolution in WASM requires absolute paths; font maps are rewritten automatically
- **Large documents**: Memory pressure with 100+ page documents
- **Some packages**: Packages requiring shell escape or external tools won't work
- **Font subsetting**: Not supported; full fonts embedded in PDFs

## Performance

Typical first-compile times (cold cache):

| Document Type | Time | Data Downloaded |
|--------------|------|-----------------|
| Hello World | ~2s | ~15MB |
| Article with math | ~4s | ~20MB |
| Beamer presentation | ~8s | ~35MB |
| Full memoir book | ~15s | ~50MB |

Subsequent compiles with warm cache: 1-3s regardless of complexity.

## Project Structure

```
.
├── busytex/                # BusyTeX submodule (build to get .js/.wasm)
├── busytex.js              # BusyTeX WASM JavaScript (built from submodule)
├── busytex.wasm            # BusyTeX WebAssembly binary (built from submodule)
├── split-bundle-lazy.html  # Main application (self-contained HTML)
├── README.md
└── packages/
    ├── bundles/            # Pre-built TeX bundles
    │   ├── *.data.gz       # Compressed bundle data
    │   ├── *.meta.json     # Bundle metadata
    │   ├── registry.json   # Bundle registry
    │   ├── package-map.json
    │   ├── file-manifest.json
    │   └── bundle-deps.json
    └── ctan-proxy.ts       # Development CTAN proxy server
```

## Development

### Running Locally

```bash
# Start file server
python3 -m http.server 8080

# (Optional) Start CTAN proxy for local caching
cd packages && bun run ctan-proxy.ts

# Open in browser
open http://localhost:8080/split-bundle-lazy.html
```

### Modifying Bundles

After modifying bundle files, regenerate the indices:

```bash
cd packages/bundles
python3 sync-package-map.py
```

## Credits

This project builds on:

- **[BusyTeX](https://github.com/busytex/busytex)** - The WASM port of TeX Live that makes browser-based LaTeX possible
- **[TeX Live](https://tug.org/texlive/)** - The underlying TeX distribution
- **[CTAN](https://ctan.org/)** - Package repository and API

## License

MIT License - see LICENSE file.

The bundled TeX Live components retain their original licenses (primarily LPPL for LaTeX packages).
