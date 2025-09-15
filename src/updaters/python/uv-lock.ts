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

import {Updater} from '../../update';
import {VersionsMap} from '../../version';
import {logger as defaultLogger, Logger} from '../../util/logger';
import {parseWith, replaceTomlValue} from '../../util/toml-edit';

interface UvLockPackage {
  name: string;
  version: string;
  source?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface UvLockContent {
  version?: number;
  requires_python?: string;
  package?: UvLockPackage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Updates a uv.lock file with new versions for workspace packages
 */
export class UvLock implements Updater {
  private versionsMap: VersionsMap;

  constructor(versionsMap: VersionsMap) {
    this.versionsMap = versionsMap;
  }

  /**
   * Given initial file contents, return updated contents.
   * @param {string} content The initial content
   * @returns {string} The updated content
   */
  updateContent(content: string, logger: Logger = defaultLogger): string {
    let data: UvLockContent;
    try {
      data = parseWith(content) as UvLockContent;
    } catch (e) {
      logger.warn('Invalid uv.lock file, cannot be parsed', e);
      return content;
    }

    if (!data.package || !Array.isArray(data.package)) {
      logger.warn('No packages found in uv.lock');
      return content;
    }

    let modified = false;
    let processedContent = content;

    // Iterate through packages and update versions for workspace packages
    data.package.forEach((pkg, index) => {
      const newVersion = this.versionsMap.get(pkg.name);
      if (newVersion) {
        logger.info(
          `Updating ${pkg.name} from ${pkg.version} to ${newVersion}`
        );

        // Update the version in the lock file
        // UV lock files use array notation for packages
        const path = ['package', index.toString(), 'version'];
        try {
          processedContent = replaceTomlValue(
            processedContent,
            path,
            newVersion.toString()
          );
          modified = true;
        } catch (e) {
          logger.warn(`Failed to update version for ${pkg.name}:`, e);
        }
      }
    });

    if (!modified) {
      logger.warn('No workspace packages found in uv.lock to update');
    }

    return processedContent;
  }
}
