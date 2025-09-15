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

import {describe, it, afterEach, beforeEach} from 'mocha';
import {expect} from 'chai';
import {GitHub} from '../../src/github';
import {UvWorkspace} from '../../src/strategies/uv-workspace';
import * as sinon from 'sinon';
import {buildGitHubFileRaw, assertHasUpdate} from '../helpers';
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
    it('handles workspace with multiple members', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'test-workspace',
      });

      const rootPyproject = `
[project]
name = "workspace-root"
version = "1.0.0"

[tool.uv.workspace]
members = ["packages/core", "packages/utils", "packages/cli"]
`;

      const corePyproject = `
[project]
name = "core-package"
version = "1.0.0"
dependencies = []
`;

      const utilsPyproject = `
[project]
name = "utils-package"
version = "1.0.0"
dependencies = []
`;

      const cliPyproject = `
[project]
name = "cli-package"
version = "1.0.0"
dependencies = ["core-package>=1.0.0", "utils-package>=1.0.0"]

[dependency-groups]
dev = ["pytest>=7.0.0"]
workspace = ["core-package==1.0.0", "utils-package==1.0.0"]
`;

      const uvLock = `
version = 1

[[package]]
name = "core-package"
version = "1.0.0"

[[package]]
name = "utils-package"
version = "1.0.0"

[[package]]
name = "cli-package"
version = "1.0.0"
`;

      const getFileContentsStub = sandbox.stub(
        github,
        'getFileContentsOnBranch'
      );

      getFileContentsStub
        .withArgs('pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(rootPyproject));
      getFileContentsStub
        .withArgs('packages/core/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(corePyproject));
      getFileContentsStub
        .withArgs('packages/utils/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(utilsPyproject));
      getFileContentsStub
        .withArgs('packages/cli/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(cliPyproject));
      getFileContentsStub
        .withArgs('uv.lock', 'main')
        .resolves(buildGitHubFileRaw(uvLock));

      const findFilesStub = sandbox.stub(github, 'findFilesByFilenameAndRef');
      findFilesStub
        .withArgs('pyproject.toml', 'main', 'packages/')
        .resolves([
          'packages/core/pyproject.toml',
          'packages/utils/pyproject.toml',
          'packages/cli/pyproject.toml',
        ]);

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

      // Check for expected updates
      assertHasUpdate(updates, 'CHANGELOG.md', Changelog);
      assertHasUpdate(updates, 'pyproject.toml', UvWorkspaceToml);
      assertHasUpdate(updates, 'packages/core/pyproject.toml', PyProjectToml);
      assertHasUpdate(updates, 'packages/utils/pyproject.toml', PyProjectToml);
      // packages/cli/pyproject.toml gets both PyProjectToml and UvWorkspaceToml updates
      // which results in a CompositeUpdater, so we just check it exists
      const cliUpdate = updates.find(u => u.path === 'packages/cli/pyproject.toml');
      expect(cliUpdate).to.not.be.undefined;
      assertHasUpdate(updates, 'uv.lock', UvLock);

      expect(updates.length).to.be.at.least(6);
    });

    it('falls back to simple Python behavior without workspace', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'simple-package',
      });

      const simplePyproject = `
[project]
name = "simple-package"
version = "1.0.0"
dependencies = ["requests>=2.0.0"]
`;

      const getFileContentsStub = sandbox.stub(
        github,
        'getFileContentsOnBranch'
      );

      getFileContentsStub
        .withArgs('pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(simplePyproject));

      const latestRelease = undefined;
      const release = await strategy.buildReleasePullRequest(
        COMMITS,
        latestRelease
      );

      const updates = release!.updates;

      // Should only have basic updates
      assertHasUpdate(updates, 'CHANGELOG.md', Changelog);
      assertHasUpdate(updates, 'pyproject.toml', PyProjectToml);

      // Should not have workspace-specific updates
      expect(updates.find(u => u.updater instanceof UvLock)).to.be.undefined;
    });

    it('handles workspace with glob patterns', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'glob-workspace',
      });

      const rootPyproject = `
[project]
name = "workspace-root"
version = "1.0.0"

[tool.uv.workspace]
members = ["packages/*"]
`;

      const getFileContentsStub = sandbox.stub(
        github,
        'getFileContentsOnBranch'
      );

      getFileContentsStub
        .withArgs('pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(rootPyproject));

      const findFilesStub = sandbox.stub(github, 'findFilesByFilenameAndRef');
      findFilesStub
        .withArgs('pyproject.toml', 'main', 'packages/')
        .resolves([
          'packages/package-a/pyproject.toml',
          'packages/package-b/pyproject.toml',
        ]);

      const packageAPyproject = `
[project]
name = "package-a"
version = "1.0.0"
`;

      const packageBPyproject = `
[project]
name = "package-b"
version = "1.0.0"
dependencies = ["package-a>=1.0.0"]
`;

      getFileContentsStub
        .withArgs('packages/package-a/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(packageAPyproject));
      getFileContentsStub
        .withArgs('packages/package-b/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(packageBPyproject));

      const latestRelease = undefined;
      const release = await strategy.buildReleasePullRequest(
        COMMITS,
        latestRelease
      );

      const updates = release!.updates;

      // Check that glob expansion worked
      assertHasUpdate(
        updates,
        'packages/package-a/pyproject.toml',
        PyProjectToml
      );
      assertHasUpdate(
        updates,
        'packages/package-b/pyproject.toml',
        PyProjectToml
      );
    });
  });

  describe('dependency tracking', () => {
    it('tracks dependencies between workspace packages', async () => {
      const strategy = new UvWorkspace({
        targetBranch: 'main',
        github,
        component: 'dependency-workspace',
      });

      const rootPyproject = `
[project]
name = "workspace-root"
version = "1.0.0"

[tool.uv.workspace]
members = ["packages/base", "packages/derived"]
`;

      const basePyproject = `
[project]
name = "base-package"
version = "1.0.0"
`;

      const derivedPyproject = `
[project]
name = "derived-package"
version = "1.0.0"
dependencies = ["base-package>=1.0.0"]

[dependency-groups]
workspace = ["base-package==1.0.0"]
`;

      const getFileContentsStub = sandbox.stub(
        github,
        'getFileContentsOnBranch'
      );

      getFileContentsStub
        .withArgs('pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(rootPyproject));
      getFileContentsStub
        .withArgs('packages/base/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(basePyproject));
      getFileContentsStub
        .withArgs('packages/derived/pyproject.toml', 'main')
        .resolves(buildGitHubFileRaw(derivedPyproject));

      const findFilesStub = sandbox.stub(github, 'findFilesByFilenameAndRef');
      findFilesStub.resolves([]);

      const latestRelease = {
        tag: new TagName(Version.parse('1.0.0'), 'dependency-workspace'),
        sha: 'abc123',
        notes: 'previous',
      };

      const release = await strategy.buildReleasePullRequest(
        COMMITS,
        latestRelease
      );

      const updates = release!.updates;

      // Should update the derived package - it will have a composite updater
      // since it gets both PyProjectToml and UvWorkspaceToml updates
      const derivedUpdate = updates.find(
        u => u.path === 'packages/derived/pyproject.toml'
      );
      expect(derivedUpdate).to.not.be.undefined;

      // Should also update base package
      const baseUpdate = updates.find(
        u => u.path === 'packages/base/pyproject.toml'
      );
      expect(baseUpdate).to.not.be.undefined;
    });
  });
});
