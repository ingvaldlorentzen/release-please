# UV Workspace Plugin Design Documentation

## Overview

This document describes the implementation of the UV workspace plugin for release-please, which adds support for managing Python monorepos that use UV's workspace feature. UV is a modern Python package manager that supports workspace management similar to Cargo (Rust) and npm (Node.js).

## Architecture Choice: Plugin vs Strategy

### Why a Plugin?

The UV workspace implementation follows the **plugin** pattern rather than the strategy pattern for several key reasons:

1. **Consistency with Existing Workspace Implementations**: All other workspace management tools in release-please are implemented as plugins:
   - `cargo-workspace` for Rust workspaces
   - `node-workspace` for npm/yarn workspaces
   - `maven-workspace` for Maven multi-module projects

2. **Workspace Management is Cross-Cutting**: Workspace management inherently affects multiple packages simultaneously and requires coordination across them. This is precisely what the plugin architecture was designed to handle.

3. **Reuses Base Strategy**: The UV workspace plugin works in conjunction with the existing `python` strategy, enhancing it with workspace-aware capabilities rather than replacing it.

## Implementation Details

### Core Components

#### 1. `UvWorkspace` Plugin (`src/plugins/uv-workspace.ts`)

The main plugin class that extends `WorkspacePlugin<UvPackageInfo>`. This follows the exact pattern used by `CargoWorkspace`:

```typescript
export class UvWorkspace extends WorkspacePlugin<UvPackageInfo>
```

**Key responsibilities:**
- Discovers all packages in the UV workspace
- Builds a dependency graph between workspace packages
- Updates versions across all interdependent packages
- Handles merging of multiple package updates into a single PR (when configured)

#### 2. `UvLock` Updater (`src/updaters/python/uv-lock.ts`)

Updates the `uv.lock` file with new versions for workspace packages. This is analogous to:
- `CargoLock` for Rust
- `package-lock.json` updates for Node.js

**Implementation notes:**
- Uses TOML parsing/editing utilities already present in the codebase
- Updates only workspace package versions, leaving external dependencies to UV

#### 3. Plugin Registration

The plugin is registered in `src/factories/plugin-factory.ts` alongside other workspace plugins:

```typescript
'uv-workspace': options =>
  new UvWorkspace(
    options.github,
    options.targetBranch,
    options.repositoryConfig,
    {
      ...options,
      ...(options.type as WorkspacePluginOptions),
      merge:
        (options.type as WorkspacePluginOptions).merge ??
        !options.separatePullRequests,
    }
  )
```

## Comparison with Existing Implementations

### Similarities with CargoWorkspace

| Feature | CargoWorkspace | UvWorkspace | Notes |
|---------|----------------|-------------|-------|
| Extends WorkspacePlugin | ✅ | ✅ | Base class provides common functionality |
| Package discovery | Via Cargo.toml members | Via pyproject.toml members | Same pattern, different config format |
| Dependency graph building | ✅ | ✅ | Both analyze inter-package dependencies |
| Lock file updates | CargoLock | UvLock | Both update respective lock files |
| Changelog dependency notes | ✅ | ✅ | Both track workspace dependency updates |
| PR merging support | ✅ | ✅ | Can merge multiple package updates |

### Key Differences

1. **Package Manifest Format**
   - Cargo: `Cargo.toml` with `[package]` section
   - UV: `pyproject.toml` with `[project]` or `[tool.poetry]` section

2. **Workspace Configuration**
   - Cargo: `[workspace.members]` in root Cargo.toml
   - UV: `[tool.uv.workspace.members]` in root pyproject.toml

3. **Dependency Specification**
   - Cargo: Structured TOML with explicit version fields
   - UV: PEP 508 dependency specifiers as strings

4. **Version Location**
   - Cargo: `package.version` field
   - UV: `project.version` or `tool.poetry.version` field

## Usage Example

### Configuration

In `.release-please-manifest.json`:
```json
{
  "packages": {
    ".": {
      "release-type": "python",
      "component": "workspace-root"
    },
    "packages/core": {
      "release-type": "python",
      "component": "core"
    },
    "packages/cli": {
      "release-type": "python",
      "component": "cli"
    }
  }
}
```

In `release-please-config.json`:
```json
{
  "packages": {
    ".": {
      "release-type": "python",
      "bump-minor-pre-major": true,
      "bump-patch-for-minor-pre-major": true
    },
    "packages/core": {
      "release-type": "python"
    },
    "packages/cli": {
      "release-type": "python"
    }
  },
  "plugins": ["uv-workspace"]
}
```

### Workspace Structure

```
project/
├── pyproject.toml          # Root with [tool.uv.workspace]
├── uv.lock                 # Shared lock file
├── packages/
│   ├── core/
│   │   └── pyproject.toml  # [project] name = "my-core"
│   └── cli/
│       └── pyproject.toml  # [project] name = "my-cli"
└── .release-please-manifest.json
```

## Design Decisions and Rationale

### 1. Reusing Existing Python Infrastructure

The plugin reuses existing Python updaters where possible:
- `PyProjectToml` for updating version fields
- `parsePyProject` for parsing pyproject.toml files
- Python strategy's changelog sections

**Rationale**: Maintains consistency with standalone Python package releases and reduces code duplication.

### 2. Minimal Lock File Updates

The `UvLock` updater only modifies workspace package versions, not dependency resolution.

**Rationale**: UV should handle dependency resolution. Release-please only needs to update the versions of packages it manages.

### 3. Support for Both PEP 517 and Poetry Formats

The plugin checks both `project.name/version` (PEP 517) and `tool.poetry.name/version` (Poetry).

**Rationale**: UV supports both formats, and many Python projects still use Poetry's configuration style.

### 4. Workspace Dependency Detection

The plugin analyzes:
- `project.dependencies`
- `project.optional-dependencies`
- `dependency-groups` (PEP 735)

**Rationale**: UV workspaces can reference other workspace packages in any of these sections.

## Testing Considerations

The implementation should be tested with:

1. **Basic workspace**: Multiple packages with no inter-dependencies
2. **Complex workspace**: Packages depending on each other
3. **Mixed dependencies**: Workspace and external dependencies
4. **Different formats**: PEP 517 and Poetry-style configurations
5. **Edge cases**: Missing versions, invalid configurations

## Benefits of This Approach

1. **Consistency**: Follows established patterns in the codebase
2. **Maintainability**: Clear separation of concerns between plugin and updaters
3. **Extensibility**: Easy to add UV-specific features in the future
4. **Integration**: Works seamlessly with existing Python strategy
5. **User Experience**: Familiar configuration for users of other workspace plugins

## Future Enhancements

Potential improvements that could be added:

1. **UV-specific version constraints**: Handle UV's extended version specifiers
2. **Workspace inheritance**: Support UV's workspace inheritance features
3. **Tool-specific updates**: Update other UV configuration in pyproject.toml
4. **Performance optimization**: Cache parsed manifests across operations

## Conclusion

The UV workspace plugin implementation as a **plugin** rather than a strategy is the correct architectural choice. It maintains consistency with existing workspace implementations, properly handles the cross-cutting nature of workspace management, and provides a clean integration with the existing Python ecosystem support in release-please.