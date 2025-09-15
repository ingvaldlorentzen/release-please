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

import {describe, it, afterEach, beforeEach} from 'mocha';
import {expect} from 'chai';
import {GitHub} from '../../src/github';
import {UvWorkspace} from '../../src/strategies/uv-workspace';
import * as sinon from 'sinon';
import {buildGitHubFileContent, buildGitHubFileRaw, assertHasUpdate} from '../helpers';
import {buildMockConventionalCommit} from '../helpers';
import {TagName} from '../../src/util/tag-name';
import {Version} from '../../src/version';
import {Changelog} from '../../src/updaters/changelog';
import {UvLock} from '../../src/updaters/python/uv-lock';
import {UvWorkspaceToml} from '../../src/updaters/python/uv-workspace-toml';
import {PyProjectToml} from '../../src/updaters/python/pyproject-toml';

const sandbox = sinon.createSandbox();

const COMMITS = [
  ...buildMockConventionalCommit(
    'fix(deps): update dependency requests to v2.28.0'
  ),
  ...buildMockConventionalCommit('feat: add new feature to core package'),
  ...buildMockConventionalCommit('chore: update CI configuration'),
];

describe('UV Workspace', () => {
  const fixturesPath = './test/fixtures/strategies/uv-workspace';
  let github: GitHub;

  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'test-owner',
      repo: 'uv-workspace-test',
      defaultBranch: 'main',
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('buildReleasePullRequest', () => {
    it('returns release PR with default initial version', async () => {
      const expectedVersion = '0.1.0';
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      const latestRelease = undefined;
      const release = await strategy.buildReleasePullRequest(
        COMMITS,
        latestRelease
      );

      expect(release!.version?.toString()).to.eql(expectedVersion);
    });

    it('returns release PR with version bump', async () => {
      const expectedVersion = '1.3.0'; // Minor bump for feat commit
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      const latestRelease = {
        tag: new TagName(Version.parse('1.2.3'), 'test-workspace'),
        sha: 'abc123',
        notes: 'previous release notes',
      };

      const release = await strategy.buildReleasePullRequest(
        COMMITS,
        latestRelease
      );

      expect(release!.version?.toString()).to.eql(expectedVersion);
    });
  });

  describe('buildUpdates', () => {
    it('builds common files for UV workspace', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      sandbox
        .stub(github, 'getFileContentsOnBranch')
        .withArgs('pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-workspace.toml')
        );

      sandbox
        .stub(github, 'findFilesByGlobAndRef')
        .withArgs('packages/*/pyproject.toml', 'main')
        .resolves(['packages/core/pyproject.toml', 'packages/utils/pyproject.toml'])
        .withArgs('apps/cli/pyproject.toml', 'main')
        .resolves(['apps/cli/pyproject.toml']);

      const latestRelease = undefined;
      const release = await strategy.buildReleasePullRequest(
        COMMITS,
        latestRelease
      );
      const updates = release!.updates;

      assertHasUpdate(updates, 'CHANGELOG.md', Changelog);
      assertHasUpdate(updates, 'pyproject.toml', UvWorkspaceToml);
      assertHasUpdate(updates, 'uv.lock', UvLock);
    });

    it('finds packages from workspace members patterns', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      sandbox
        .stub(github, 'getFileContentsOnBranch')
        .withArgs('pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-workspace.toml')
        )
        .withArgs('packages/core/pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-core.toml')
        )
        .withArgs('packages/utils/pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-utils.toml')
        )
        .withArgs('apps/cli/pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-cli.toml')
        );

      sandbox
        .stub(github, 'findFilesByGlobAndRef')
        .withArgs('packages/*/pyproject.toml', 'main')
        .resolves(['packages/core/pyproject.toml', 'packages/utils/pyproject.toml'])
        .withArgs('apps/cli/pyproject.toml', 'main')
        .resolves(['apps/cli/pyproject.toml']);

      const latestRelease = {
        tag: new TagName(Version.parse('1.0.0'), 'test-workspace'),
        sha: 'abc123',
        notes: 'previous release',
      };

      const release = await strategy.buildReleasePullRequest(
        COMMITS,
        latestRelease
      );
      const updates = release!.updates;

      assertHasUpdate(updates, 'pyproject.toml', UvWorkspaceToml);
      assertHasUpdate(updates, 'packages/core/pyproject.toml', PyProjectToml);
      assertHasUpdate(updates, 'packages/utils/pyproject.toml', PyProjectToml);
      assertHasUpdate(updates, 'apps/cli/pyproject.toml', UvWorkspaceToml);
      assertHasUpdate(updates, 'uv.lock', UvLock);
      assertHasUpdate(updates, 'CHANGELOG.md', Changelog);
    });

    it('updates cross-package dependencies correctly', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      const workspaceToml = `[project]
name = "workspace-root"
version = "1.0.0"

[dependency-groups]
dev = [
  "core-package==1.0.0",
  "utils-package>=1.0.0"
]

[tool.uv.workspace]
members = ["packages/*"]`;

      const cliToml = `[project]
name = "cli-app"
version = "1.0.0"
dependencies = [
  "core-package==1.0.0",
  "utils-package>=1.0.0"
]

[tool.uv.sources]
core-package = { workspace = true }
utils-package = { workspace = true }`;

      sandbox
        .stub(github, 'getFileContentsOnBranch')
        .withArgs('pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(workspaceToml))
        .withArgs('packages/cli/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(cliToml))
        .withArgs('packages/core/pyproject.toml', 'main')
        .resolves(buildGitHubFileContent(fixturesPath, 'pyproject-core.toml'))
        .withArgs('packages/utils/pyproject.toml', 'main')
        .resolves(buildGitHubFileContent(fixturesPath, 'pyproject-utils.toml'));

      sandbox
        .stub(github, 'findFilesByGlobAndRef')
        .withArgs('packages/*/pyproject.toml', 'main')
        .resolves([
          'packages/cli/pyproject.toml',
          'packages/core/pyproject.toml',
          'packages/utils/pyproject.toml',
        ]);

      const release = await strategy.buildReleasePullRequest(COMMITS, undefined);
      const updates = release!.updates;

      // The CLI app should use UvWorkspaceToml updater because it has dependencies on workspace packages
      const cliUpdate = updates.find(u => u.path === 'packages/cli/pyproject.toml');
      expect(cliUpdate).to.exist;
      expect(cliUpdate!.updater).to.be.instanceOf(UvWorkspaceToml);

      // Verify cross-package dependencies will be updated
      const rootUpdate = updates.find(u => u.path === 'pyproject.toml');
      expect(rootUpdate).to.exist;
      expect(rootUpdate!.updater).to.be.instanceOf(UvWorkspaceToml);
    });

    it('throws error when workspace configuration is missing', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      sandbox
        .stub(github, 'getFileContentsOnBranch')
        .withArgs('pyproject.toml', 'main')
        .resolves(
          buildGitHubFileRaw(`[project]
name = "simple-package"
version = "1.0.0"`)
        );

      try {
        await strategy.buildReleasePullRequest(COMMITS, undefined);
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.include('No UV workspace configuration found');
      }
    });

    it('throws error when member pyproject.toml is missing', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      sandbox
        .stub(github, 'getFileContentsOnBranch')
        .withArgs('pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(
            fixturesPath,
            'pyproject-workspace.toml'
          )
        )
        .withArgs('packages/missing/pyproject.toml', 'main')
        .resolves(undefined);

      sandbox
        .stub(github, 'findFilesByGlobAndRef')
        .withArgs('packages/*/pyproject.toml', 'main')
        .resolves(['packages/missing/pyproject.toml'])
        .withArgs('apps/cli/pyproject.toml', 'main')
        .resolves([]);

      try {
        await strategy.buildReleasePullRequest(COMMITS, undefined);
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.include('pyproject.toml not found');
      }
    });

    it('handles uv.lock file updates correctly', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      const getFileStub = sandbox.stub(github, 'getFileContentsOnBranch');
      getFileStub
        .withArgs('pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-workspace.toml')
        )
        .withArgs('packages/core/pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-core.toml')
        )
        .withArgs('packages/utils/pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-utils.toml')
        )
        .withArgs('apps/cli/pyproject.toml', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'pyproject-cli.toml')
        )
        .withArgs('uv.lock', 'main')
        .resolves(
          buildGitHubFileContent(fixturesPath, 'uv.lock')
        );

      sandbox
        .stub(github, 'findFilesByGlobAndRef')
        .withArgs('packages/*/pyproject.toml', 'main')
        .resolves(['packages/core/pyproject.toml', 'packages/utils/pyproject.toml'])
        .withArgs('apps/cli/pyproject.toml', 'main')
        .resolves(['apps/cli/pyproject.toml']);

      const release = await strategy.buildReleasePullRequest(COMMITS, undefined);
      const updates = release!.updates;

      const uvLockUpdate = updates.find(u => u.path === 'uv.lock');
      expect(uvLockUpdate).to.exist;
      expect(uvLockUpdate!.updater).to.be.instanceOf(UvLock);

      // Verify the UvLock updater has the versions map
      const uvLockUpdater = uvLockUpdate!.updater as UvLock;
      const fileContent = await getFileStub('uv.lock', 'main');
      const content = uvLockUpdater.updateContent(fileContent!.parsedContent);
      expect(content).to.include('version = "0.1.0"'); // Should update to initial version
    });
  });
});