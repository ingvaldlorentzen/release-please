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

import * as TOML from '@iarna/toml';
import {logger as defaultLogger, Logger} from '../../util/logger';
import {replaceTomlValue} from '../../util/toml-edit';
import {DefaultUpdater} from '../default';
import {Version, VersionsMap} from '../../version';

interface UvWorkspaceTomlContent {
  project?: {
    name?: string;
    version?: string;
    dependencies?: string[];
  };
  tool?: {
    uv?: {
      workspace?: {
        members?: string[];
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sources?: Record<string, any>;
    };
  };
  'dependency-groups'?: Record<string, string[]>;
}

/**
 * Updates a pyproject.toml file with UV workspace-aware dependency handling
 */
export class UvWorkspaceToml extends DefaultUpdater {
  constructor(options: {version: Version; versionsMap?: VersionsMap}) {
    super(options);
  }

  /**
   * Given initial file contents, return updated contents.
   * @param {string} content The initial content
   * @returns {string} The updated content
   */
  updateContent(content: string, logger: Logger = defaultLogger): string {
    const parsed = TOML.parse(content) as UvWorkspaceTomlContent;

    let processedContent = content;

    // Update the package version if it exists
    if (parsed.project?.version) {
      processedContent = replaceTomlValue(
        processedContent,
        ['project', 'version'],
        this.version.toString()
      );
    }

    // If we have a versions map, update dependency-groups
    if (this.versionsMap && parsed['dependency-groups']) {
      processedContent = this.updateDependencyGroups(
        processedContent,
        parsed['dependency-groups'],
        logger
      );
    }

    // Update workspace dependencies in the dependencies array
    if (this.versionsMap && parsed.project?.dependencies) {
      processedContent = this.updateDependencies(
        processedContent,
        parsed.project.dependencies,
        logger
      );
    }

    return processedContent;
  }

  private updateDependencyGroups(
    content: string,
    dependencyGroups: Record<string, string[]>,
    logger: Logger
  ): string {
    let processedContent = content;

    for (const [groupName, dependencies] of Object.entries(dependencyGroups)) {
      dependencies.forEach((dep, index) => {
        const updatedDep = this.updateDependencyString(dep, logger);
        if (updatedDep !== dep) {
          const path = ['dependency-groups', groupName, index.toString()];
          try {
            processedContent = replaceTomlValue(
              processedContent,
              path,
              updatedDep
            );
          } catch (e) {
            logger.warn(
              `Failed to update dependency ${dep} in group ${groupName}:`,
              e
            );
          }
        }
      });
    }

    return processedContent;
  }

  private updateDependencies(
    content: string,
    dependencies: string[],
    logger: Logger
  ): string {
    let processedContent = content;

    dependencies.forEach((dep, index) => {
      const updatedDep = this.updateDependencyString(dep, logger);
      if (updatedDep !== dep) {
        const path = ['project', 'dependencies', index.toString()];
        try {
          processedContent = replaceTomlValue(
            processedContent,
            path,
            updatedDep
          );
        } catch (e) {
          logger.warn(`Failed to update dependency ${dep}:`, e);
        }
      }
    });

    return processedContent;
  }

  private updateDependencyString(dependency: string, _logger: Logger): string {
    if (!this.versionsMap) return dependency;

    // Parse dependency string (e.g., "package>=1.0.0" or "package==1.0.0")
    const match = dependency.match(/^([a-zA-Z0-9_-]+)(.*)/);
    if (!match) return dependency;

    const [, packageName, versionSpec] = match;
    const newVersion = this.versionsMap.get(packageName);

    if (!newVersion) return dependency;

    // Update the version in the dependency string
    // Handle different version specifiers
    if (versionSpec.includes('==')) {
      return `${packageName}==${newVersion}`;
    } else if (versionSpec.includes('>=')) {
      return `${packageName}>=${newVersion}`;
    } else if (versionSpec.includes('^')) {
      return `${packageName}^${newVersion}`;
    } else if (versionSpec.includes('~')) {
      return `${packageName}~${newVersion}`;
    } else if (versionSpec.trim() === '') {
      // No version specified, add one
      return `${packageName}==${newVersion}`;
    }

    // Default: replace any version with exact match
    return `${packageName}==${newVersion}`;
  }
}
