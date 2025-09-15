// Copyright 2025 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {GitHubFileContents} from '@google-automations/git-file-utils';
import {BaseStrategy, BuildUpdatesOptions} from './base';
import {VersionsMap, Version} from '../version';
import {Update} from '../update';
import {Changelog} from '../updaters/changelog';
import {PyProjectToml} from '../updaters/python/pyproject-toml';
import {UvLock} from '../updaters/python/uv-lock';
import {UvWorkspaceToml} from '../updaters/python/uv-workspace-toml';
import * as TOML from '@iarna/toml';

interface UvWorkspaceConfig {
  members?: string[];
  exclude?: string[];
}

interface UvSource {
  workspace?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface UvWorkspaceManifest {
  project?: {
    name?: string;
    version?: string;
    dependencies?: string[];
  };
  tool?: {
    uv?: {
      workspace?: UvWorkspaceConfig;
      sources?: Record<string, UvSource>;
    };
  };
  'dependency-groups'?: Record<string, string[]>;
}

export class UvWorkspace extends BaseStrategy {
  private workspaceManifest?: UvWorkspaceManifest | null;
  private memberManifests: Map<string, UvWorkspaceManifest> = new Map();
  private dependencyGraph: Map<string, Set<string>> = new Map();

  protected async buildUpdates(
    options: BuildUpdatesOptions
  ): Promise<Update[]> {
    const updates: Update[] = [];
    const version = options.newVersion;

    // Add changelog if not skipped
    !this.skipChangelog &&
      updates.push({
        path: this.addPath(this.changelogPath),
        createIfMissing: true,
        updater: new Changelog({
          version,
          changelogEntry: options.changelogEntry,
        }),
      });

    // Parse workspace configuration
    const workspaceManifest = await this.getWorkspaceManifest();
    if (!workspaceManifest?.tool?.uv?.workspace?.members) {
      this.logger.warn('No UV workspace configuration found');
      // Fall back to simple Python strategy behavior
      updates.push({
        path: this.addPath('pyproject.toml'),
        createIfMissing: false,
        updater: new PyProjectToml({
          version,
        }),
      });
      return updates;
    }

    const members = workspaceManifest.tool.uv.workspace.members;
    const versionsMap: VersionsMap = new Map();

    // If root has a package, add it to versions map
    if (workspaceManifest.project?.name) {
      versionsMap.set(workspaceManifest.project.name, version);
    }

    this.logger.info(
      `Found UV workspace with ${members.length} members, upgrading all`
    );

    // Parse all member manifests and build dependency graph
    await this.parseMemberManifests(members);
    await this.buildDependencyGraph();

    // Collect all package names and versions
    for (const [, manifest] of this.memberManifests) {
      if (manifest.project?.name) {
        versionsMap.set(manifest.project.name, version);
      }
    }

    this.logger.debug('Versions map:', versionsMap);

    // Update root pyproject.toml
    updates.push({
      path: this.addPath('pyproject.toml'),
      createIfMissing: false,
      updater: new UvWorkspaceToml({
        version,
        versionsMap,
      }),
    });

    // Update member pyproject.toml files
    for (const [memberPath, manifest] of this.memberManifests) {
      const pyprojectPath = `${memberPath}/pyproject.toml`;
      updates.push({
        path: this.addPath(pyprojectPath),
        createIfMissing: false,
        updater: new PyProjectToml({
          version,
        }),
      });

      // If this member has dependencies on other workspace packages,
      // update those references in dependency-groups
      if (manifest['dependency-groups']) {
        updates.push({
          path: this.addPath(pyprojectPath),
          createIfMissing: false,
          updater: new UvWorkspaceToml({
            version,
            versionsMap,
          }),
        });
      }
    }

    // Update uv.lock file
    updates.push({
      path: this.addPath('uv.lock'),
      createIfMissing: false,
      updater: new UvLock(versionsMap),
    });

    return updates;
  }

  private async parseMemberManifests(members: string[]): Promise<void> {
    for (const member of members) {
      // Handle glob patterns
      const memberPaths = await this.expandWorkspaceMember(member);
      for (const memberPath of memberPaths) {
        const manifestPath = `${memberPath}/pyproject.toml`;
        const manifestContent = await this.getContent(manifestPath);
        if (!manifestContent) {
          this.logger.warn(
            `Member ${memberPath} declared but did not find pyproject.toml`
          );
          continue;
        }
        const manifest = this.parseManifest(manifestContent.parsedContent);
        this.memberManifests.set(memberPath, manifest);
      }
    }
  }

  private async expandWorkspaceMember(pattern: string): Promise<string[]> {
    // Simple implementation - handle exact paths and basic globs
    if (!pattern.includes('*')) {
      return [pattern];
    }

    // For glob patterns, we need to list directories
    // This is a simplified version - in production, would use proper glob library
    const basePath = pattern.split('*')[0];
    try {
      const files = await this.github.findFilesByFilenameAndRef(
        'pyproject.toml',
        this.targetBranch,
        basePath
      );
      return files
        .map(f => f.replace('/pyproject.toml', ''))
        .filter(p => p.startsWith(basePath));
    } catch (e) {
      this.logger.warn(`Failed to expand workspace pattern ${pattern}:`, e);
      return [];
    }
  }

  private async buildDependencyGraph(): Promise<void> {
    // Build a graph of which packages depend on which workspace packages
    for (const [, manifest] of this.memberManifests) {
      const packageName = manifest.project?.name;
      if (!packageName) continue;

      const dependencies = new Set<string>();

      // Check regular dependencies
      if (manifest.project?.dependencies) {
        for (const dep of manifest.project.dependencies) {
          const depName = this.extractPackageName(dep);
          if (this.isWorkspacePackage(depName)) {
            dependencies.add(depName);
          }
        }
      }

      // Check dependency groups
      if (manifest['dependency-groups']) {
        for (const group of Object.values(manifest['dependency-groups'])) {
          for (const dep of group) {
            const depName = this.extractPackageName(dep);
            if (this.isWorkspacePackage(depName)) {
              dependencies.add(depName);
            }
          }
        }
      }

      this.dependencyGraph.set(packageName, dependencies);
    }
  }

  private extractPackageName(dependency: string): string {
    // Extract package name from dependency specifier
    // e.g., "package>=1.0.0" -> "package"
    return dependency.split(/[<>=!]/)[0].trim();
  }

  private isWorkspacePackage(packageName: string): boolean {
    // Check if a package name is one of our workspace packages
    for (const manifest of this.memberManifests.values()) {
      if (manifest.project?.name === packageName) {
        return true;
      }
    }
    return this.workspaceManifest?.project?.name === packageName;
  }

  private async getWorkspaceManifest(): Promise<UvWorkspaceManifest | null> {
    if (this.workspaceManifest === undefined) {
      this.workspaceManifest = await this.getManifest('pyproject.toml');
    }
    return this.workspaceManifest;
  }

  private async getContent(path: string): Promise<GitHubFileContents | null> {
    try {
      return await this.github.getFileContentsOnBranch(
        this.addPath(path),
        this.targetBranch
      );
    } catch (e) {
      return null;
    }
  }

  private async getManifest(path: string): Promise<UvWorkspaceManifest | null> {
    const content = await this.getContent(path);
    return content ? this.parseManifest(content.parsedContent) : null;
  }

  private parseManifest(content: string): UvWorkspaceManifest {
    return TOML.parse(content) as UvWorkspaceManifest;
  }

  protected initialReleaseVersion(): Version {
    return Version.parse('0.1.0');
  }

  async getDefaultPackageName(): Promise<string | undefined> {
    const manifest = await this.getWorkspaceManifest();
    return manifest?.project?.name;
  }
}
