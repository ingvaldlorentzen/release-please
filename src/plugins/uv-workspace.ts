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

import {CandidateReleasePullRequest, ROOT_PROJECT_PATH} from '../manifest';
import {
  WorkspacePlugin,
  DependencyGraph,
  DependencyNode,
  addPath,
  appendDependenciesSectionToChangelog,
} from './workspace';
import {VersionsMap, Version} from '../version';
import {RawContent} from '../updaters/raw-content';
import {Changelog} from '../updaters/changelog';
import {ReleasePullRequest} from '../release-pull-request';
import {PullRequestTitle} from '../util/pull-request-title';
import {PullRequestBody} from '../util/pull-request-body';
import {BranchName} from '../util/branch-name';
import {PatchVersionUpdate} from '../versioning-strategy';
import {ConfigurationError} from '../errors';
import {Strategy} from '../strategy';
import {Commit} from '../commit';
import {Release} from '../release';
import {PyProjectToml} from '../updaters/python/pyproject-toml';
import {parsePyProject} from '../updaters/python/pyproject-toml';
import {UvLock} from '../updaters/python/uv-lock';
import * as TOML from '@iarna/toml';

interface UvPackageInfo {
  /**
   * e.g. `packages/package-a`
   */
  path: string;

  /**
   * e.g. `package-a`
   */
  name: string;

  /**
   * e.g. `1.0.0`
   */
  version: string;

  /**
   * e.g. `packages/package-a/pyproject.toml`
   */
  manifestPath: string;

  /**
   * text content of the manifest, used for updates
   */
  manifestContent: string;

  /**
   * Parsed pyproject.toml
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manifest: any;
}

/**
 * The plugin analyzed a UV workspace and will bump dependencies
 * of managed packages if those dependencies are being updated.
 *
 * If multiple python packages are being updated, it will merge them
 * into a single python package.
 */
export class UvWorkspace extends WorkspacePlugin<UvPackageInfo> {
  private strategiesByPath: Record<string, Strategy> = {};
  private releasesByPath: Record<string, Release> = {};

  protected async buildAllPackages(
    candidates: CandidateReleasePullRequest[]
  ): Promise<{
    allPackages: UvPackageInfo[];
    candidatesByPackage: Record<string, CandidateReleasePullRequest>;
  }> {
    const pyprojectContent = await this.github.getFileContentsOnBranch(
      'pyproject.toml',
      this.targetBranch
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pyprojectManifest = TOML.parse(pyprojectContent.parsedContent) as any;

    // Check if this is a UV workspace
    if (!pyprojectManifest.tool?.uv?.workspace?.members) {
      this.logger.warn(
        "uv-workspace plugin used, but top-level pyproject.toml isn't a UV workspace"
      );
      return {allPackages: [], candidatesByPackage: {}};
    }

    const allPackages: UvPackageInfo[] = [];
    const candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};

    const members = (
      await Promise.all(
        pyprojectManifest.tool.uv.workspace.members.map((member: string) =>
          this.github.findFilesByGlobAndRef(member, this.targetBranch)
        )
      )
    ).flat();
    members.push(ROOT_PROJECT_PATH);

    for (const path of members) {
      const manifestPath = addPath(path, 'pyproject.toml');
      this.logger.info(`looking for candidate with path: ${path}`);
      const candidate = candidates.find(c => c.path === path);

      // get original content of the package
      const manifestContent =
        candidate?.pullRequest.updates.find(
          update => update.path === manifestPath
        )?.cachedFileContents ||
        (await this.github.getFileContentsOnBranch(
          manifestPath,
          this.targetBranch
        ));
      const manifest = parsePyProject(manifestContent.parsedContent);
      const packageName = manifest.project?.name || manifest.tool?.poetry?.name;

      if (!packageName) {
        this.logger.warn(
          `package manifest at ${manifestPath} is missing project.name or tool.poetry.name`
        );
        continue;
      }

      if (candidate) {
        candidatesByPackage[packageName] = candidate;
      }

      const version =
        manifest.project?.version || manifest.tool?.poetry?.version;
      if (!version) {
        throw new ConfigurationError(
          `package manifest at ${manifestPath} is missing version`,
          'uv-workspace',
          `${this.github.repository.owner}/${this.github.repository.repo}`
        );
      } else if (typeof version !== 'string') {
        throw new ConfigurationError(
          `package manifest at ${manifestPath} has an invalid version`,
          'uv-workspace',
          `${this.github.repository.owner}/${this.github.repository.repo}`
        );
      }

      allPackages.push({
        path,
        name: packageName,
        version,
        manifest,
        manifestContent: manifestContent.parsedContent,
        manifestPath,
      });
    }

    return {
      allPackages,
      candidatesByPackage,
    };
  }

  protected bumpVersion(pkg: UvPackageInfo): Version {
    const version = Version.parse(pkg.version);
    return new PatchVersionUpdate().bump(version);
  }

  protected updateCandidate(
    existingCandidate: CandidateReleasePullRequest,
    pkg: UvPackageInfo,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    const version = updatedVersions.get(pkg.name);
    if (!version) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }

    const updater = new PyProjectToml({
      version,
    });
    const updatedContent = updater.updateContent(pkg.manifestContent);
    const originalManifest = parsePyProject(pkg.manifestContent);
    const updatedManifest = parsePyProject(updatedContent);
    const dependencyNotes = getChangelogDepsNotes(
      originalManifest,
      updatedManifest,
      updatedVersions
    );

    existingCandidate.pullRequest.updates =
      existingCandidate.pullRequest.updates.map(update => {
        if (update.path === addPath(existingCandidate.path, 'pyproject.toml')) {
          update.updater = new RawContent(updatedContent);
        } else if (update.updater instanceof Changelog && dependencyNotes) {
          update.updater.changelogEntry = appendDependenciesSectionToChangelog(
            update.updater.changelogEntry,
            dependencyNotes,
            this.logger
          );
        } else if (update.path === addPath(existingCandidate.path, 'uv.lock')) {
          update.updater = new UvLock(updatedVersions);
        }
        return update;
      });

    // append dependency notes
    if (dependencyNotes) {
      if (existingCandidate.pullRequest.body.releaseData.length > 0) {
        existingCandidate.pullRequest.body.releaseData[0].notes =
          appendDependenciesSectionToChangelog(
            existingCandidate.pullRequest.body.releaseData[0].notes,
            dependencyNotes,
            this.logger
          );
      } else {
        existingCandidate.pullRequest.body.releaseData.push({
          component: pkg.name,
          version: existingCandidate.pullRequest.version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        });
      }
    }
    return existingCandidate;
  }

  protected async newCandidate(
    pkg: UvPackageInfo,
    updatedVersions: VersionsMap
  ): Promise<CandidateReleasePullRequest> {
    const version = updatedVersions.get(pkg.name);
    if (!version) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }

    const updater = new PyProjectToml({
      version,
    });
    const updatedContent = updater.updateContent(pkg.manifestContent);
    const originalManifest = parsePyProject(pkg.manifestContent);
    const updatedManifest = parsePyProject(updatedContent);
    const dependencyNotes = getChangelogDepsNotes(
      originalManifest,
      updatedManifest,
      updatedVersions
    );

    const updatedPackage = {
      ...pkg,
      version: version.toString(),
    };

    const strategy = this.strategiesByPath[updatedPackage.path];
    const latestRelease = this.releasesByPath[updatedPackage.path];
    const basePullRequest = strategy
      ? await strategy.buildReleasePullRequest([], latestRelease, false, [], {
          newVersion: version,
        })
      : undefined;

    if (basePullRequest) {
      return this.updateCandidate(
        {
          path: pkg.path,
          pullRequest: basePullRequest,
          config: {
            releaseType: 'python',
          },
        },
        pkg,
        updatedVersions
      );
    }

    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([
        {
          component: pkg.name,
          version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        },
      ]),
      updates: [
        {
          path: addPath(pkg.path, 'pyproject.toml'),
          createIfMissing: false,
          updater: new RawContent(updatedContent),
        },
        {
          path: addPath(pkg.path, 'CHANGELOG.md'),
          createIfMissing: false,
          updater: new Changelog({
            version,
            changelogEntry: dependencyNotes,
          }),
        },
      ],
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version,
      draft: false,
    };
    return {
      path: pkg.path,
      pullRequest,
      config: {
        releaseType: 'python',
      },
    };
  }

  protected postProcessCandidates(
    candidates: CandidateReleasePullRequest[],
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest[] {
    let rootCandidate = candidates.find(c => c.path === ROOT_PROJECT_PATH);
    if (!rootCandidate) {
      this.logger.warn('Unable to find root candidate pull request');
      rootCandidate = candidates.find(c => c.config.releaseType === 'python');
    }
    if (!rootCandidate) {
      this.logger.warn('Unable to find a python candidate pull request');
      return candidates;
    }

    // Update the root uv.lock if it exists
    rootCandidate.pullRequest.updates.push({
      path: 'uv.lock',
      createIfMissing: false,
      updater: new UvLock(updatedVersions),
    });

    return candidates;
  }

  protected async buildGraph(
    allPackages: UvPackageInfo[]
  ): Promise<DependencyGraph<UvPackageInfo>> {
    const workspacePackageNames = new Set(
      allPackages.map(packageInfo => packageInfo.name)
    );
    const graph = new Map<string, DependencyNode<UvPackageInfo>>();

    for (const packageInfo of allPackages) {
      const allDeps: string[] = [];

      // Collect dependencies from various sections
      if (packageInfo.manifest.project?.dependencies) {
        allDeps.push(...packageInfo.manifest.project.dependencies);
      }

      if (packageInfo.manifest.project?.['optional-dependencies']) {
        for (const deps of Object.values(
          packageInfo.manifest.project['optional-dependencies']
        )) {
          allDeps.push(...(deps as string[]));
        }
      }

      if (packageInfo.manifest['dependency-groups']) {
        for (const deps of Object.values(
          packageInfo.manifest['dependency-groups']
        )) {
          allDeps.push(...(deps as string[]));
        }
      }

      // Extract package names from dependency specifications
      const workspaceDeps = allDeps
        .map(dep => extractPackageName(dep))
        .filter(dep => workspacePackageNames.has(dep));

      graph.set(packageInfo.name, {
        deps: workspaceDeps,
        value: packageInfo,
      });
    }

    return graph;
  }

  protected inScope(candidate: CandidateReleasePullRequest): boolean {
    return candidate.config.releaseType === 'python';
  }

  protected packageNameFromPackage(pkg: UvPackageInfo): string {
    return pkg.name;
  }

  protected pathFromPackage(pkg: UvPackageInfo): string {
    return pkg.path;
  }

  async preconfigure(
    strategiesByPath: Record<string, Strategy>,
    _commitsByPath: Record<string, Commit[]>,
    _releasesByPath: Record<string, Release>
  ): Promise<Record<string, Strategy>> {
    // Using preconfigure to siphon releases and strategies.
    this.strategiesByPath = strategiesByPath;
    this.releasesByPath = _releasesByPath;

    return strategiesByPath;
  }
}

function extractPackageName(dependency: string): string {
  // Extract package name from dependency specification
  // e.g., "package>=1.0.0" -> "package"
  // e.g., "package[extra]==1.2.3" -> "package"
  const match = dependency.match(/^([a-zA-Z0-9_-]+)/);
  return match ? match[1] : dependency;
}

function getChangelogDepsNotes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalManifest: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updatedManifest: any,
  updatedVersions: VersionsMap
): string {
  let depUpdateNotes = '';
  const updates: Map<string, Set<string>> = new Map();

  // Check project dependencies
  if (
    originalManifest.project?.dependencies &&
    updatedManifest.project?.dependencies
  ) {
    const depUpdates = compareDepLists(
      originalManifest.project.dependencies,
      updatedManifest.project.dependencies,
      updatedVersions
    );
    if (depUpdates.length > 0) {
      const currentUpdates = updates.get('dependencies') || new Set();
      depUpdates.forEach(update => currentUpdates.add(update));
      updates.set('dependencies', currentUpdates);
    }
  }

  // Check optional dependencies
  if (
    originalManifest.project?.['optional-dependencies'] &&
    updatedManifest.project?.['optional-dependencies']
  ) {
    for (const group in updatedManifest.project['optional-dependencies']) {
      const origDeps =
        originalManifest.project['optional-dependencies'][group] || [];
      const updatedDeps =
        updatedManifest.project['optional-dependencies'][group];
      const depUpdates = compareDepLists(
        origDeps,
        updatedDeps,
        updatedVersions
      );
      if (depUpdates.length > 0) {
        const key = `optional-dependencies.${group}`;
        const currentUpdates = updates.get(key) || new Set();
        depUpdates.forEach(update => currentUpdates.add(update));
        updates.set(key, currentUpdates);
      }
    }
  }

  // Check dependency groups
  if (
    originalManifest['dependency-groups'] &&
    updatedManifest['dependency-groups']
  ) {
    for (const group in updatedManifest['dependency-groups']) {
      const origDeps = originalManifest['dependency-groups'][group] || [];
      const updatedDeps = updatedManifest['dependency-groups'][group];
      const depUpdates = compareDepLists(
        origDeps,
        updatedDeps,
        updatedVersions
      );
      if (depUpdates.length > 0) {
        const key = `dependency-groups.${group}`;
        const currentUpdates = updates.get(key) || new Set();
        depUpdates.forEach(update => currentUpdates.add(update));
        updates.set(key, currentUpdates);
      }
    }
  }

  for (const [section, notes] of updates) {
    depUpdateNotes += `\n  * ${section}`;
    for (const note of notes) {
      depUpdateNotes += note;
    }
  }

  if (depUpdateNotes) {
    return `* The following workspace dependencies were updated${depUpdateNotes}`;
  }
  return '';
}

function compareDepLists(
  originalDeps: string[],
  updatedDeps: string[],
  updatedVersions: VersionsMap
): string[] {
  const depUpdates: string[] = [];

  for (const updatedDep of updatedDeps) {
    const packageName = extractPackageName(updatedDep);
    const newVersion = updatedVersions.get(packageName);

    if (newVersion) {
      const originalDep = originalDeps.find(
        dep => extractPackageName(dep) === packageName
      );

      if (originalDep && originalDep !== updatedDep) {
        depUpdates.push(`\n    * ${packageName} bumped to ${newVersion}`);
      }
    }
  }

  return depUpdates;
}
