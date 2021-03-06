// Copyright (c) Dolittle. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import path from 'path';
import { valid as isValidSemver, SemVer } from 'semver';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { exec } from '@actions/exec';
import { Logger } from '@dolittle/github-actions.shared.logging';
import { Project } from '@dolittle/typescript.build';
const editJsonFile = require('edit-json-file');

const logger = new Logger();

run();
export async function run() {
    try {
        const version = core.getInput('version', { required: true });
        if (!isValidSemver(version)) throw new Error(`${version} is not a valid SemVer`);
        const root = path.join(process.env.GITHUB_WORKSPACE!, core.getInput('root', { required: true }));
        const project = new Project(root);
        logger.info(`Creating release from root ${project.root}`);
        changeVersionNumbers(version, project);
        await exec(
            'git config',
            [
                'user.email',
                '"build@dolittle.com"'
            ],
            { cwd: root, ignoreReturnCode: true});
        await exec(
            'git config',
            [
                'user.name',
                '"dolittle-build"'
            ],
            { cwd: root, ignoreReturnCode: true});
        await exec(
            'git commit',
            [
                '--author="github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>"',
                `-am "Update packages and workspace dependencies to ${version}"`
            ],
            { cwd: root, ignoreReturnCode: true});
        const branchName = path.basename(github.context.ref);
        await exec(
            `git push origin ${branchName}`,
            undefined,
            { cwd: root, ignoreReturnCode: true});
        if (!await publishPackages(project, new SemVer(version))) throw new Error('One or more packages failed to publish');
    } catch (error) {
        fail(error);
    }
}

function getPackages(project: Project) {
    return project.hasWorkspaces() ?
        project.workspaces.map(_ => _.workspacePackage)
        : [project.rootPackage];
}

function changeVersionNumbers(version: string, project: Project) {
    const packages = getPackages(project);
    packages.forEach(_ => {
        const file = editJsonFile(_.path, { stringify_width: 4 });
        const packageObject = file.toObject();
        logger.info(`Updating ${_.packageObject.name} to version ${version}`);
        file.set('version', version);

        if (project.hasWorkspaces()) {
            const workspaceNames = packages.map(_ => _.packageObject.name);
            const dependencyFields = Object.keys(packageObject).filter(_ => _.endsWith('dependencies') || _.endsWith('Dependencies'));
            for (let field of dependencyFields) {
                const dependencies = packageObject[field] ?? {};
                for (let dependencyName of Object.keys(dependencies)) {
                    if (workspaceNames.includes(dependencyName)) {
                        logger.info(`Updating workspace ${field} '${dependencyName}' to version ${version}`);
                        dependencyName = dependencyName.replace(/\./g, '\\.');
                        field = field.replace(/\./g, '\\.');
                        const key = `${field}.${dependencyName}`;
                        file.set(key, version);
                    }
                }
            }
        }
        file.save();
    });
}

async function publishPackages(project: Project, version: SemVer) {
    const packages = getPackages(project);
    let allSucceeded = true;
    for (const packageToPublish of packages) {
        if ((packageToPublish.packageObject as any).private === true) {
            logger.info(`Skipping publishing of ${packageToPublish.packageObject.name}`);
            continue;
        }
        logger.info(`Publishing ${packageToPublish.packageObject.name}`);
        const args: string[] = [];
        const prerelease = version.prerelease;
        if (prerelease?.length && prerelease.length > 0) {
            args.push('--tag');
            args.push(prerelease[0] as string);
        }
        if (await exec('npm publish', args, { ignoreReturnCode: true, cwd: packageToPublish.rootFolder}) !== 0) allSucceeded = false;
    }
    return allSucceeded;
}

function fail(error: Error) {
    logger.error(error.message);
    core.setFailed(error.message);
}
