# Plan: UV-Workspace Aware Release-Please Strategy

## Problem Statement
Projects using **uv workspaces** face significant release-please configuration complexity:
- **Manual configuration** with repetitive `extra-files` entries for each workspace package
- **Cross-package dependencies** requiring manual version synchronization
- **Workspace sources** and dependency groups needing manual maintenance
- **Scaling issues** - configuration grows linearly with workspace members (e.g., 7 packages = 102 config lines)

## Proposed Solution: Custom UvWorkspace Strategy

### 1. Create UvWorkspace Strategy Class
- **Extend BaseStrategy** similar to Rust plugin
- **Parse workspace configuration** from root `pyproject.toml`
- **Auto-detect workspace members** from `tool.uv.workspace.members`
- **Track dependency relationships** between workspace packages

### 2. Core Functionality Implementation
- **buildUpdates() method**: Generate file updates for all workspace packages
- **Workspace dependency resolution**: Update consuming packages when workspace packages change versions
- **uv.lock management**: Update lockfile entries automatically with proper JSONPath queries
- **Cross-package version bumping**: When package A updates, update all packages that depend on A

### 3. Key Components to Build
- **UvManifestParser**: Parse `pyproject.toml` files for workspace config and dependencies
- **WorkspaceDependencyTracker**: Map which packages depend on each other
- **UvLockUpdater**: Handle `uv.lock` file updates with proper JSONPath queries
- **PyprojectUpdater**: Update dependency versions in consuming pyproject.toml files

### 4. Configuration Simplification
Replace current verbose config with simple:
```json
{
  "release-type": "uv-workspace",
  "workspace-root": "."
}
```

### 5. Benefits Achieved
- **Eliminate repetitive configuration** (100+ lines → ~10 lines)
- **Automatic dependency cascading** when workspace packages update
- **Consistent workspace-wide version management**
- **Auto-discovery of new workspace members**
- **Reduced maintenance burden** when adding/removing packages

### 6. Implementation Steps
1. Study Rust strategy implementation patterns
2. Create UvWorkspace strategy class extending BaseStrategy
3. Implement workspace parsing and dependency tracking
4. Add file updaters for pyproject.toml and uv.lock
5. Test with uv workspace monorepo structures
6. Submit as upstream contribution to release-please

## Plugin Development Details

### Language and Platform
- **Language**: TypeScript/JavaScript (Node.js)
- **Release-please is written in Node.js** and strategies are TypeScript classes
- **No Python involved** - the plugin runs in the release-please Node.js environment

### Integration and Distribution Options

#### Option 1: Upstream Contribution (Recommended)
- **Fork release-please repository**
- **Develop uv-workspace strategy** following existing patterns
- **Submit pull request** to googleapis/release-please
- **Benefits**: Official support, maintained by community, available to all users
- **Timeline**: Longer due to review process, but sustainable long-term

#### Option 2: Custom Fork/Branch
- **Fork release-please** and maintain custom branch
- **Use custom release-please in GitHub Actions** via direct repository reference
- **Benefits**: Immediate availability, full control
- **Drawbacks**: Maintenance burden, staying sync with upstream

#### Option 3: External Plugin (Experimental/Unofficial)
- **Status**: Not officially documented, but working examples exist
- **Example**: `@ipfs-shipyard/release-please-ipfs-plugin` demonstrates this approach
- **Requirements**:
  - NPM package with proper plugin structure
  - Manual CLI invocation with `--plugin` flag
  - Plugin must register itself within release-please system
- **GitHub Action Limitation**: Standard action doesn't support custom plugins
- **Complexity**: Medium - requires understanding release-please internals

### Workflow Integration

#### Current Workflow Update
Your GitHub Actions workflow would use either:

**Option 1 (Upstream):**
```yaml
- uses: googleapis/release-please-action@v4
  with:
    release-type: uv-workspace  # New strategy type
    config-file: .github/release/config.json
```

**Option 2 (Custom Fork):**
```yaml
- name: Release Please
  uses: your-org/release-please-action@main
  with:
    release-type: uv-workspace
    config-file: .github/release/config.json
```

**Option 3 (External Plugin):**
```yaml
- name: Install Plugin
  run: npm install -g @your-org/release-please-uv-workspace-plugin

- name: Release Please with Plugin
  run: |
    npx release-please release-pr \
      --token=${{ secrets.GITHUB_TOKEN }} \
      --repo-url=${{ github.repository }} \
      --plugin=@your-org/release-please-uv-workspace-plugin \
      --release-type=uv-workspace
```

## Technical Details

### Typical Configuration Complexity
Current uv workspace release-please configs have repetitive patterns:
- Each package needs `extra-files` entries for `uv.lock` JSONPath updates
- Each package needs `extra-files` entries for consuming pyproject.toml updates
- Manual maintenance when adding new workspace members
- Linear growth: N packages = ~15N configuration lines

### UV Workspace Structure Pattern
```
workspace-root/
├── pyproject.toml              # Workspace root with [tool.uv.workspace]
├── uv.lock                     # Shared lockfile
├── core-package/
│   └── pyproject.toml          # Contains dependency groups referencing workspace packages
├── workspace-member-1/
│   └── pyproject.toml          # Workspace member
├── workspace-member-2/
│   └── pyproject.toml          # Workspace member
└── ... (other workspace members)
```

### Dependency Flow Patterns
1. **Workspace Sources**: Root `pyproject.toml` declares workspace packages with `workspace = true`
2. **Dependency Groups**: Consuming packages reference workspace packages in dependency groups
3. **Version Synchronization**: When a workspace package version changes, all dependent packages must be updated
4. **Lock File Management**: `uv.lock` contains resolved versions for all workspace packages

### Implementation Reference: Rust Strategy
The existing Rust strategy provides an excellent template:
- Parses workspace members from `Cargo.toml`
- Creates version maps for cross-package updates
- Updates both root and member manifests
- Handles workspace-specific file patterns

### Proposed Plugin Architecture
```typescript
class UvWorkspace extends BaseStrategy {
  // Parse workspace configuration and member packages
  private async parseWorkspaceManifest(): Promise<WorkspaceConfig>

  // Track which packages depend on workspace members
  private async buildDependencyGraph(): Promise<DependencyGraph>

  // Generate updates for all affected files
  protected async buildUpdates(options: BuildUpdatesOptions): Promise<Update[]>

  // Handle uv.lock and pyproject.toml updates
  private createWorkspaceUpdates(versionsMap: VersionsMap): Update[]
}
```

### Development Workflow

#### Setup and Testing
```bash
# Fork and clone release-please
git clone https://github.com/your-org/release-please.git
cd release-please
npm install

# Create new strategy
# Add to src/strategies/uv-workspace.ts
# Register in src/factory.ts

# Test locally
npm test
npm run compile

# Test against your uv workspace repo
node build/src/bin/release-please.js release-pr \
  --token=$GITHUB_TOKEN \
  --repo-url=your-org/your-uv-workspace-repo \
  --release-type=uv-workspace
```

#### Required Files to Create/Modify
1. **`src/strategies/uv-workspace.ts`** - Main strategy implementation
2. **`src/updaters/pyproject-toml.ts`** - Enhanced TOML updater for dependency groups
3. **`src/factory.ts`** - Register new strategy type
4. **`test/strategies/uv-workspace.ts`** - Comprehensive tests
5. **`schemas/config.json`** - Schema validation for new strategy

### Expected Outcome
A single, maintainable release strategy that:
- Automatically discovers workspace members
- Handles cross-package version dependencies
- Eliminates configuration duplication
- Supports standard uv workspace structures
- Can be contributed back to the release-please project

## Execution Plan: Custom Fork Implementation

### Chosen Approach: Option 2 (Custom Fork)

#### What You Need to Fork
1. **`googleapis/release-please`** - The core library
2. **`googleapis/release-please-action`** - The GitHub Action wrapper

#### Distribution Strategy
**Simplest Approach:**
1. Fork `googleapis/release-please-action`
2. Modify it to use your custom `release-please` fork as dependency
3. Use your forked action directly in workflows

**Implementation Steps:**
```bash
# Fork both repositories
gh repo fork googleapis/release-please
gh repo fork googleapis/release-please-action

# In your release-please-action fork, update package.json:
{
  "dependencies": {
    "release-please": "github:your-org/release-please#custom-uv-workspace"
  }
}

# Build and publish your action
npm run build
git commit -am "Use custom release-please with uv-workspace support"
git push
```

**Usage in your project:**
```yaml
- uses: your-org/release-please-action@main  # Uses your custom version
  with:
    release-type: uv-workspace
```

### Option 3: External Plugin Implementation

#### Plugin Structure
Based on the IPFS plugin example, you would create:
```
release-please-uv-workspace-plugin/
├── package.json
├── src/
│   ├── plugin.ts          # Main plugin entry
│   ├── strategy.ts        # UV workspace strategy
│   └── updaters/
│       └── pyproject.ts   # Custom TOML handling
└── test/
```

#### Limitations of External Plugin Approach
- **GitHub Action incompatibility**: Can't use standard `release-please-action`
- **Manual CLI usage**: Must run `npx release-please` directly
- **Experimental status**: No official support or documentation
- **Complex workflow**: Requires custom GitHub Actions setup

### Next Steps Decision Point
## Ready-to-Execute Checklist

### Phase 1: Fork and Setup (Day 1)
- [ ] Fork `googleapis/release-please` to your organization
- [ ] Fork `googleapis/release-please-action` to your organization
- [ ] Clone both forks locally
- [ ] Set up development environment (`npm install`)
- [ ] Run existing tests to verify setup (`npm test`)

### Phase 2: Core Implementation (Days 2-5)
- [ ] Study existing Rust strategy implementation (`src/strategies/rust.ts`)
- [ ] Create `src/strategies/uv-workspace.ts` with BaseStrategy extension
- [ ] Implement workspace manifest parsing (pyproject.toml)
- [ ] Create dependency graph tracking between packages
- [ ] Implement `buildUpdates()` method for file modifications

### Phase 3: File Updaters (Days 6-7)
- [ ] Enhance `src/updaters/pyproject-toml.ts` for dependency groups
- [ ] Create uv.lock updater with JSONPath support
- [ ] Register new strategy in `src/factory.ts`
- [ ] Update schema validation in `schemas/config.json`

### Phase 4: Testing and Integration (Days 8-10)
- [ ] Write comprehensive tests in `test/strategies/uv-workspace.ts`
- [ ] Test locally with your uv workspace project
- [ ] Update release-please-action to use your custom fork
- [ ] Deploy and test end-to-end workflow

### Success Criteria
✅ Configuration reduced from 100+ lines to <10 lines
✅ Automatic workspace member discovery
✅ Cross-package version dependency updates
✅ uv.lock automatic synchronization
✅ GitHub Actions integration working seamlessly