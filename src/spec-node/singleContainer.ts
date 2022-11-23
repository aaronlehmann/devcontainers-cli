/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createContainerProperties, startEventSeen, ResolverResult, getTunnelInformation, getDockerfilePath, getDockerContextPath, DockerResolverParameters, isDockerFileConfig, uriToWSLFsPath, WorkspaceConfiguration, getFolderImageName, SubstitutedConfig, checkDockerSupportForGPU } from './utils';
import { ContainerProperties, setupInContainer, ResolverProgress, ResolverParameters } from '../spec-common/injectHeadless';
import { ContainerError, toErrorText } from '../spec-common/errors';
import { ContainerDetails, listContainers, DockerCLIParameters, inspectContainers, dockerCLI, dockerPtyCLI, toPtyExecParameters, ImageDetails, toExecParameters } from '../spec-shutdown/dockerUtils';
import { DevContainerConfig, DevContainerFromDockerfileConfig, DevContainerFromImageConfig } from '../spec-configuration/configuration';
import { LogLevel, Log, makeLog } from '../spec-utils/log';
import { extendImage, getExtendImageBuildInfo } from './containerFeatures';
import { getDevcontainerMetadata, getImageBuildInfoFromDockerfile, getImageMetadataFromContainer, ImageMetadataEntry, mergeConfiguration, MergedDevContainerConfig } from './imageMetadata';
import { ensureDockerfileHasFinalStageName } from './dockerfileUtils';

export const hostFolderLabel = 'devcontainer.local_folder'; // used to label containers created from a workspace/folder

export async function openDockerfileDevContainer(params: DockerResolverParameters, configWithRaw: SubstitutedConfig<DevContainerFromDockerfileConfig | DevContainerFromImageConfig>, workspaceConfig: WorkspaceConfiguration, idLabels: string[], additionalFeatures: Record<string, string | boolean | Record<string, string | boolean>>): Promise<ResolverResult> {
	const { common } = params;
	const { config } = configWithRaw;
	// let collapsedFeaturesConfig: () => Promise<CollapsedFeaturesConfig | undefined>;

	let container: ContainerDetails | undefined;
	let containerProperties: ContainerProperties | undefined;

	try {
		container = await findExistingContainer(params, idLabels);
		let mergedConfig: MergedDevContainerConfig;
		if (container) {
			// let _collapsedFeatureConfig: Promise<CollapsedFeaturesConfig | undefined>;
			// collapsedFeaturesConfig = async () => {
			// 	return _collapsedFeatureConfig || (_collapsedFeatureConfig = (async () => {
			// 		const allLabels = container?.Config.Labels || {};
			// 		const featuresConfig = await generateFeaturesConfig(params.common, (await createFeaturesTempFolder(params.common)), config, async () => allLabels, getContainerFeaturesFolder);
			// 		return collapseFeaturesConfig(featuresConfig);
			// 	})());
			// };
			await startExistingContainer(params, idLabels, container);
			const imageMetadata = getImageMetadataFromContainer(container, configWithRaw, undefined, idLabels, common.experimentalImageMetadata, common.output).config;
			mergedConfig = mergeConfiguration(config, imageMetadata);
		} else {
			return bailOut(common.output, 'Code removed.');
		}

		containerProperties = await createContainerProperties(params, container.Id, workspaceConfig.workspaceFolder, mergedConfig.remoteUser);
		return await setupContainer(container, params, containerProperties, config, mergedConfig);

	} catch (e) {
		throw createSetupError(e, container, params, containerProperties, config);
	}
}

function createSetupError(originalError: any, container: ContainerDetails | undefined, params: DockerResolverParameters, containerProperties: ContainerProperties | undefined, config: DevContainerConfig | undefined): ContainerError {
	const err = originalError instanceof ContainerError ? originalError : new ContainerError({
		description: 'An error occurred setting up the container.',
		originalError
	});
	if (container) {
		err.manageContainer = true;
		err.params = params.common;
		err.containerId = container.Id;
		err.dockerParams = params;
	}
	if (containerProperties) {
		err.containerProperties = containerProperties;
	}
	if (config) {
		err.config = config;
	}
	return err;
}

async function setupContainer(container: ContainerDetails, params: DockerResolverParameters, containerProperties: ContainerProperties, config: DevContainerFromDockerfileConfig | DevContainerFromImageConfig, mergedConfig: MergedDevContainerConfig): Promise<ResolverResult> {
	const { common } = params;
	const {
		remoteEnv: extensionHostEnv,
	} = await setupInContainer(common, containerProperties, mergedConfig);

	return {
		params: common,
		properties: containerProperties,
		config,
		resolvedAuthority: {
			extensionHostEnv,
		},
		tunnelInformation: common.isLocalContainer ? getTunnelInformation(container) : {},
		dockerParams: params,
		dockerContainerId: container.Id,
	};
}

function getDefaultName(config: DevContainerFromDockerfileConfig | DevContainerFromImageConfig, params: DockerResolverParameters) {
	return 'image' in config ? config.image : getFolderImageName(params.common);
}
export async function buildNamedImageAndExtend(params: DockerResolverParameters, configWithRaw: SubstitutedConfig<DevContainerFromDockerfileConfig | DevContainerFromImageConfig>, additionalFeatures: Record<string, string | boolean | Record<string, string | boolean>>, canAddLabelsToContainer: boolean, argImageNames?: string[]): Promise<{ updatedImageName: string[]; imageMetadata: SubstitutedConfig<ImageMetadataEntry[]>; labels?: Record<string, string> }> {
	const { config } = configWithRaw;
	const imageNames = argImageNames ?? [getDefaultName(config, params)];
	params.common.progress(ResolverProgress.BuildingImage);
	if (isDockerFileConfig(config)) {
		return await buildAndExtendImage(params, configWithRaw as SubstitutedConfig<DevContainerFromDockerfileConfig>, imageNames, params.buildNoCache ?? false, additionalFeatures);
	}
	// image-based dev container - extend
	return await extendImage(params, configWithRaw, imageNames[0], additionalFeatures, canAddLabelsToContainer);
}

async function buildAndExtendImage(buildParams: DockerResolverParameters, configWithRaw: SubstitutedConfig<DevContainerFromDockerfileConfig>, baseImageNames: string[], noCache: boolean, additionalFeatures: Record<string, string | boolean | Record<string, string | boolean>>) {
	const { cliHost, output } = buildParams.common;
	const { config } = configWithRaw;
	const dockerfileUri = getDockerfilePath(cliHost, config);
	const dockerfilePath = await uriToWSLFsPath(dockerfileUri, cliHost);
	if (!cliHost.isFile(dockerfilePath)) {
		throw new ContainerError({ description: `Dockerfile (${dockerfilePath}) not found.` });
	}

	let dockerfile = (await cliHost.readFile(dockerfilePath)).toString();
	const originalDockerfile = dockerfile;
	let baseName = 'dev_container_auto_added_stage_label';
	if (config.build?.target) {
		// Explictly set build target for the dev container build features on that
		baseName = config.build.target;
	} else {
		// Use the last stage in the Dockerfile
		// Find the last line that starts with "FROM" (possibly preceeded by white-space)
		const { lastStageName, modifiedDockerfile } = ensureDockerfileHasFinalStageName(dockerfile, baseName);
		baseName = lastStageName;
		if (modifiedDockerfile) {
			dockerfile = modifiedDockerfile;
		}
	}

	const imageBuildInfo = await getImageBuildInfoFromDockerfile(buildParams, originalDockerfile, config.build?.args || {}, config.build?.target, configWithRaw.substitute, buildParams.common.experimentalImageMetadata);
	const extendImageBuildInfo = await getExtendImageBuildInfo(buildParams, configWithRaw, baseName, imageBuildInfo, undefined, additionalFeatures, false);

	let finalDockerfilePath = dockerfilePath;
	const additionalBuildArgs: string[] = [];
	if (extendImageBuildInfo?.featureBuildInfo) {
		const { featureBuildInfo } = extendImageBuildInfo;
		// We add a '# syntax' line at the start, so strip out any existing line
		const syntaxMatch = dockerfile.match(/^\s*#\s*syntax\s*=.*[\r\n]/g);
		if (syntaxMatch) {
			dockerfile = dockerfile.slice(syntaxMatch[0].length);
		}
		let finalDockerfileContent = `${featureBuildInfo.dockerfilePrefixContent}${dockerfile}\n${featureBuildInfo.dockerfileContent}`;
		finalDockerfilePath = cliHost.path.join(featureBuildInfo?.dstFolder, 'Dockerfile-with-features');
		await cliHost.writeFile(finalDockerfilePath, Buffer.from(finalDockerfileContent));

		// track additional build args to include below
		for (const buildContext in featureBuildInfo.buildKitContexts) {
			additionalBuildArgs.push('--build-context', `${buildContext}=${featureBuildInfo.buildKitContexts[buildContext]}`);
		}
		for (const buildArg in featureBuildInfo.buildArgs) {
			additionalBuildArgs.push('--param', `${buildArg}=${featureBuildInfo.buildArgs[buildArg]}`);
		}
	}

	const args: string[] = ['build'];
	args.push('--dockerfile', finalDockerfilePath);

	baseImageNames.map(imageName => args.push('--image-name', imageName));

	const target = extendImageBuildInfo?.featureBuildInfo ? extendImageBuildInfo.featureBuildInfo.overrideTarget : config.build?.target;
	if (target) {
		args.push('--target', target);
	}
	if (!noCache) {
		args.push('--cache');
	}
	const buildArgs = config.build?.args;
	if (buildArgs) {
		for (const key in buildArgs) {
			args.push('--param', `${key}=${buildArgs[key]}`);
		}
	}
	args.push(...additionalBuildArgs);
	args.push('--build-path', await uriToWSLFsPath(getDockerContextPath(cliHost, config), cliHost));
	try {
		buildParams.dockerCLI = 'newt';
		if (buildParams.isTTY) {
			const infoParams = { ...toPtyExecParameters(buildParams), output: makeLog(output, LogLevel.Info) };
			await dockerPtyCLI(infoParams, process.cwd(), ...args);
		} else {
			const infoParams = { ...toExecParameters(buildParams), output: makeLog(output, LogLevel.Info), print: 'continuous' as 'continuous' };
			await dockerCLI(infoParams, process.cwd(), ...args);
		}
	} catch (err) {
		throw new ContainerError({ description: 'An error occurred building the image.', originalError: err, data: { fileWithError: dockerfilePath } });
	}

	return {
		updatedImageName: baseImageNames,
		imageMetadata: getDevcontainerMetadata(imageBuildInfo.metadata, configWithRaw, extendImageBuildInfo?.featuresConfig),
	};
}

export function findUserArg(runArgs: string[] = []) {
	for (let i = runArgs.length - 1; i >= 0; i--) {
		const runArg = runArgs[i];
		if ((runArg === '-u' || runArg === '--user') && i + 1 < runArgs.length) {
			return runArgs[i + 1];
		}
		if (runArg.startsWith('-u=') || runArg.startsWith('--user=')) {
			return runArg.substr(runArg.indexOf('=') + 1);
		}
	}
	return undefined;
}

export async function findExistingContainer(params: DockerResolverParameters, labels: string[]) {
	const { common } = params;
	let container = await findDevContainer(params, labels);
	if (params.expectExistingContainer && !container) {
		throw new ContainerError({ description: 'The expected container does not exist.' });
	}
	if (container && (params.removeOnStartup === true || params.removeOnStartup === container.Id)) {
		const text = 'Removing Existing Container';
		const start = common.output.start(text);
		await dockerCLI(params, 'rm', '-f', container.Id);
		common.output.stop(text, start);
		container = undefined;
	}
	return container;
}

async function startExistingContainer(params: DockerResolverParameters, labels: string[], container: ContainerDetails) {
	const { common } = params;
	const start = container.State.Status !== 'running';
	if (start) {
		const starting = 'Starting container';
		const start = common.output.start(starting);
		await dockerCLI(params, 'start', container.Id);
		common.output.stop(starting, start);
		let startedContainer = await findDevContainer(params, labels);
		if (!startedContainer) {
			bailOut(common.output, 'Dev container not found.');
		}
	}
	return start;
}

export async function findDevContainer(params: DockerCLIParameters | DockerResolverParameters, labels: string[]): Promise<ContainerDetails | undefined> {
	const ids = await listContainers(params, true, labels);
	const details = await inspectContainers(params, ids);
	return details.filter(container => container.State.Status !== 'removing')[0];
}

export async function extraRunArgs(common: ResolverParameters, params: DockerCLIParameters | DockerResolverParameters, config: DevContainerFromDockerfileConfig | DevContainerFromImageConfig) {
	const extraArguments: string[] = [];
	if (config.hostRequirements?.gpu) {
		if (await checkDockerSupportForGPU(params)) {
			common.output.write(`GPU support found, add GPU flags to docker call.`);
			extraArguments.push('--gpus', 'all');
		} else {
			if (config.hostRequirements?.gpu !== 'optional') {
				common.output.write('No GPU support found yet a GPU was required - consider marking it as "optional"', LogLevel.Warning);
			}
		}
	}
	return extraArguments;
}

export async function spawnDevContainer(params: DockerResolverParameters, config: DevContainerFromDockerfileConfig | DevContainerFromImageConfig, mergedConfig: MergedDevContainerConfig, imageName: string, labels: string[], workspaceMount: string | undefined, imageDetails: (() => Promise<ImageDetails>) | undefined, containerUser: string | undefined, extraLabels: Record<string, string>) {
	const { common } = params;
	common.progress(ResolverProgress.StartingContainer);

	const appPort = config.appPort;
	const exposedPorts = typeof appPort === 'number' || typeof appPort === 'string' ? [appPort] : appPort || [];
	const exposed = (<string[]>[]).concat(...exposedPorts.map(port => ['-p', typeof port === 'number' ? `127.0.0.1:${port}:${port}` : port]));

	const cwdMount = workspaceMount ? ['--mount', workspaceMount] : [];

	const envObj = mergedConfig.containerEnv || {};
	const containerEnv = Object.keys(envObj)
		.reduce((args, key) => {
			args.push('-e', `${key}=${envObj[key]}`);
			return args;
		}, [] as string[]);

	const containerUserArgs = containerUser ? ['-u', containerUser] : [];

	const featureArgs: string[] = [];
	if (mergedConfig.init) {
		featureArgs.push('--init');
	}
	if (mergedConfig.privileged) {
		featureArgs.push('--privileged');
	}
	for (const cap of mergedConfig.capAdd || []) {
		featureArgs.push('--cap-add', cap);
	}
	for (const securityOpt of mergedConfig.securityOpt || []) {
		featureArgs.push('--security-opt', securityOpt);
	}

	const featureMounts = ([] as string[]).concat(
		...[
			...mergedConfig.mounts || [],
			...params.additionalMounts,
		].map(m => ['--mount', typeof m === 'string' ? m : `type=${m.type},src=${m.source},dst=${m.target}`])
	);

	const customEntrypoints = mergedConfig.entrypoints || [];
	const entrypoint = ['--entrypoint', '/bin/sh'];
	const cmd = ['-c', `echo Container started
trap "exit 0" 15
${customEntrypoints.join('\n')}
exec "$@"
while sleep 1 & wait $!; do :; done`, '-']; // `wait $!` allows for the `trap` to run (synchronous `sleep` would not).
	const overrideCommand = mergedConfig.overrideCommand;
	if (overrideCommand === false && imageDetails) {
		const details = await imageDetails();
		cmd.push(...details.Config.Entrypoint || []);
		cmd.push(...details.Config.Cmd || []);
	}

	const args = [
		'run',
		'--sig-proxy=false',
		'-a', 'STDOUT',
		'-a', 'STDERR',
		...exposed,
		...cwdMount,
		...featureMounts,
		...getLabels(labels),
		...containerEnv,
		...containerUserArgs,
		...(config.runArgs || []),
		...(await extraRunArgs(common, params, config) || []),
		...featureArgs,
		...entrypoint,
		...Object.keys(extraLabels).map(key => ['-l', `${key}=${extraLabels[key]}`]).flat(),
		imageName,
		...cmd
	];

	let cancel: () => void;
	const canceled = new Promise<void>((_, reject) => cancel = reject);
	const { started } = await startEventSeen(params, getLabelsAsRecord(labels), canceled, common.output, common.getLogLevel() === LogLevel.Trace);

	const text = 'Starting container';
	const start = common.output.start(text);

	const infoParams = { ...toPtyExecParameters(params), output: makeLog(params.common.output, LogLevel.Info) };
	const result = dockerPtyCLI(infoParams, ...args);
	result.then(cancel!, cancel!);

	await started;
	common.output.stop(text, start);
}

function getLabels(labels: string[]): string[] {
	let result: string[] = [];
	labels.forEach(each => result.push('-l', each));
	return result;
}

function getLabelsAsRecord(labels: string[]): Record<string, string> {
	let result: Record<string, string> = {};
	labels.forEach(each => {
		let pair = each.split('=');
		result[pair[0]] = pair[1];
	});
	return result;
}

export function bailOut(output: Log, message: string): never {
	output.write(toErrorText(message));
	throw new Error(message);
}
