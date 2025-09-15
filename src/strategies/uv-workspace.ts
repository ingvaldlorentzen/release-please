// Copyright 2024 Google LLC
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
  git?: string;
  url?: string;
  path?: string;
  tag?: string;
  branch?: string;
  rev?: string;
}

interface UvWorkspaceManifest {
  project?: {
    name?: string;
    version?: string;
    dependencies?: string[];
    description?: string;
    readme?: string;
    'requires-python'?: string;
    license?: string | {text?: string; file?: string};
    authors?: Array<{name?: string; email?: string}>;
  };
  tool?: {
    uv?: {
      workspace?: UvWorkspaceConfig;
      sources?: Record<string, UvSource>;
    };
  };
  'dependency-groups'?: Record<string, string[]>;
  'build-system'?: {
    requires?: string[];
    'build-backend'?: string;
  };
}

export class UvWorkspace extends BaseStrategy {
  private workspaceManifest?: UvWorkspaceManifest | null;
  private memberManifests: Map<string, UvWorkspaceManifest> = new Map();

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
      throw new Error(
        'No UV workspace configuration found in pyproject.toml. Expected [tool.uv.workspace] with members array.'
      );
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

    // Parse all member manifests
    await this.parseMemberManifests(members);

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

      // Use UvWorkspaceToml updater if the member has dependency-groups
      // that might reference other workspace packages, otherwise use
      // the standard PyProjectToml updater
      const updater = manifest['dependency-groups']
        ? new UvWorkspaceToml({
            version,
            versionsMap,
          })
        : new PyProjectToml({
            version,
          });

      updates.push({
        path: this.addPath(pyprojectPath),
        createIfMissing: false,
        updater,
      });
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
          throw new Error(
            `Workspace member '${memberPath}' declared but pyproject.toml not found at ${manifestPath}`
          );
        }
        const manifest = this.parseManifest(manifestContent.parsedContent);
        this.memberManifests.set(memberPath, manifest);
      }
    }
  }

  private async expandWorkspaceMember(pattern: string): Promise<string[]> {
    // Handle exact paths without glob patterns
    if (!pattern.includes('*')) {
      return [pattern];
    }

    // Use the proper glob matching from GitHub API
    // Find all pyproject.toml files matching the pattern
    const globPattern = `${pattern}/pyproject.toml`;
    try {
      const files = await this.github.findFilesByGlobAndRef(
        globPattern,
        this.targetBranch
      );
      // Extract directory path from file paths
      return files.map(f => f.replace('/pyproject.toml', ''));
    } catch (e) {
      this.logger.error(`Failed to expand workspace pattern ${pattern}:`, e);
      throw new Error(
        `Failed to expand workspace member pattern '${pattern}': ${e}`
      );
    }
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
