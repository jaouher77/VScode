/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { createHash } from 'crypto';
import * as resources from 'vs/base/common/resources';
import { Event, Emitter } from 'vs/base/common/event';
import * as pfs from 'vs/base/node/pfs';
import * as errors from 'vs/base/common/errors';
import * as collections from 'vs/base/common/collections';
import { Disposable, IDisposable, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { RunOnceScheduler, Delayer } from 'vs/base/common/async';
import { FileChangeType, FileChangesEvent, IContent, IFileService } from 'vs/platform/files/common/files';
import { ConfigurationModel } from 'vs/platform/configuration/common/configurationModels';
import { WorkspaceConfigurationModelParser, FolderSettingsModelParser, StandaloneConfigurationModelParser } from 'vs/workbench/services/configuration/common/configurationModels';
import { FOLDER_SETTINGS_PATH, TASKS_CONFIGURATION_KEY, FOLDER_SETTINGS_NAME, LAUNCH_CONFIGURATION_KEY } from 'vs/workbench/services/configuration/common/configuration';
import { IStoredWorkspaceFolder } from 'vs/platform/workspaces/common/workspaces';
import * as extfs from 'vs/base/node/extfs';
import { JSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditingService';
import { WorkbenchState, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';
import { extname, join } from 'vs/base/common/path';
import { equals } from 'vs/base/common/objects';
import { Schemas } from 'vs/base/common/network';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IConfigurationModel, compare } from 'vs/platform/configuration/common/configuration';
import { FileServiceBasedUserConfiguration, NodeBasedUserConfiguration } from 'vs/platform/configuration/node/configuration';

export class LocalUserConfiguration extends Disposable {

	private readonly userConfigurationResource: URI;
	private userConfiguration: NodeBasedUserConfiguration | FileServiceBasedUserConfiguration;
	private changeDisposable: IDisposable = Disposable.None;

	private readonly _onDidChangeConfiguration: Emitter<ConfigurationModel> = this._register(new Emitter<ConfigurationModel>());
	public readonly onDidChangeConfiguration: Event<ConfigurationModel> = this._onDidChangeConfiguration.event;

	constructor(
		environmentService: IEnvironmentService
	) {
		super();
		this.userConfigurationResource = URI.file(environmentService.appSettingsPath);
		this.userConfiguration = this._register(new NodeBasedUserConfiguration(environmentService.appSettingsPath));
		this.changeDisposable = this._register(this.userConfiguration.onDidChangeConfiguration(configurationModel => this._onDidChangeConfiguration.fire(configurationModel)));
	}

	initialize(): Promise<ConfigurationModel> {
		return this.userConfiguration.initialize();
	}

	reload(): Promise<ConfigurationModel> {
		return this.userConfiguration.reload();
	}

	async adopt(fileService: IFileService): Promise<ConfigurationModel | null> {
		if (this.userConfiguration instanceof NodeBasedUserConfiguration) {
			this.userConfiguration.dispose();
			dispose(this.changeDisposable);
			this.userConfiguration = this._register(new FileServiceBasedUserConfiguration(this.userConfigurationResource, fileService));
			this.changeDisposable = this._register(this.userConfiguration.onDidChangeConfiguration(configurationModel => this._onDidChangeConfiguration.fire(configurationModel)));
		}
		return null;
	}
}

export class RemoteUserConfiguration extends Disposable {

	private readonly _cachedConfiguration: CachedUserConfiguration;
	private _userConfiguration: FileServiceBasedUserConfiguration | CachedUserConfiguration;

	private readonly _onDidChangeConfiguration: Emitter<ConfigurationModel> = this._register(new Emitter<ConfigurationModel>());
	public readonly onDidChangeConfiguration: Event<ConfigurationModel> = this._onDidChangeConfiguration.event;

	constructor(
		remoteAuthority: string,
		environmentService: IEnvironmentService
	) {
		super();
		this._userConfiguration = this._cachedConfiguration = new CachedUserConfiguration(remoteAuthority, environmentService);
	}

	initialize(): Promise<ConfigurationModel> {
		return this._userConfiguration.initialize();
	}

	reload(): Promise<ConfigurationModel> {
		return this._userConfiguration.reload();
	}

	async adopt(configurationResource: URI | null, fileService: IFileService): Promise<ConfigurationModel | null> {
		if (this._userConfiguration instanceof CachedUserConfiguration) {
			const oldConfigurationModel = this._userConfiguration.getConfigurationModel();
			let newConfigurationModel = new ConfigurationModel();
			if (configurationResource) {
				this._userConfiguration = new FileServiceBasedUserConfiguration(configurationResource, fileService);
				this._register(this._userConfiguration.onDidChangeConfiguration(configurationModel => this.onDidUserConfigurationChange(configurationModel)));
				newConfigurationModel = await this._userConfiguration.initialize();
			}
			const { added, updated, removed } = compare(oldConfigurationModel, newConfigurationModel);
			if (added.length > 0 || updated.length > 0 || removed.length > 0) {
				this.updateCache(newConfigurationModel);
				return newConfigurationModel;
			}
		}
		return null;
	}

	private onDidUserConfigurationChange(configurationModel: ConfigurationModel): void {
		this.updateCache(configurationModel);
		this._onDidChangeConfiguration.fire(configurationModel);
	}

	private updateCache(configurationModel: ConfigurationModel): Promise<void> {
		return this._cachedConfiguration.updateConfiguration(configurationModel);
	}
}

class CachedUserConfiguration extends Disposable {

	private readonly _onDidChange: Emitter<ConfigurationModel> = this._register(new Emitter<ConfigurationModel>());
	readonly onDidChange: Event<ConfigurationModel> = this._onDidChange.event;

	private readonly cachedFolderPath: string;
	private readonly cachedConfigurationPath: string;
	private configurationModel: ConfigurationModel;

	constructor(
		remoteAuthority: string,
		private environmentService: IEnvironmentService
	) {
		super();
		this.cachedFolderPath = join(this.environmentService.userDataPath, 'CachedConfigurations', 'user', remoteAuthority);
		this.cachedConfigurationPath = join(this.cachedFolderPath, 'configuration.json');
		this.configurationModel = new ConfigurationModel();
	}

	getConfigurationModel(): ConfigurationModel {
		return this.configurationModel;
	}

	initialize(): Promise<ConfigurationModel> {
		return this.reload();
	}

	reload(): Promise<ConfigurationModel> {
		return pfs.readFile(this.cachedConfigurationPath)
			.then(content => content.toString(), () => '')
			.then(content => {
				try {
					const parsed: IConfigurationModel = JSON.parse(content);
					this.configurationModel = new ConfigurationModel(parsed.contents, parsed.keys, parsed.overrides);
				} catch (e) {
				}
				return this.configurationModel;
			});
	}

	updateConfiguration(configurationModel: ConfigurationModel): Promise<void> {
		const raw = JSON.stringify(configurationModel.toJSON());
		return this.createCachedFolder().then(created => {
			if (created) {
				return configurationModel.keys.length ? pfs.writeFile(this.cachedConfigurationPath, raw) : pfs.rimraf(this.cachedFolderPath);
			}
			return undefined;
		});
	}

	private createCachedFolder(): Promise<boolean> {
		return Promise.resolve(pfs.exists(this.cachedFolderPath))
			.then(undefined, () => false)
			.then(exists => exists ? exists : pfs.mkdirp(this.cachedFolderPath).then(() => true, () => false));
	}
}

export interface IWorkspaceIdentifier {
	id: string;
	configPath: URI;
}

export class WorkspaceConfiguration extends Disposable {

	private readonly _cachedConfiguration: CachedWorkspaceConfiguration;
	private _workspaceConfiguration: IWorkspaceConfiguration;
	private _workspaceIdentifier: IWorkspaceIdentifier | null = null;
	private _fileService: IFileService | null = null;

	private readonly _onDidUpdateConfiguration: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidUpdateConfiguration: Event<void> = this._onDidUpdateConfiguration.event;

	constructor(
		environmentService: IEnvironmentService
	) {
		super();
		this._cachedConfiguration = new CachedWorkspaceConfiguration(environmentService);
		this._workspaceConfiguration = this._cachedConfiguration;
	}

	adopt(fileService: IFileService): Promise<boolean> {
		if (!this._fileService) {
			this._fileService = fileService;
			if (this.adoptWorkspaceConfiguration()) {
				if (this._workspaceIdentifier) {
					return this._workspaceConfiguration.load(this._workspaceIdentifier).then(() => true);
				}
			}
		}
		return Promise.resolve(false);
	}

	load(workspaceIdentifier: IWorkspaceIdentifier): Promise<void> {
		this._workspaceIdentifier = workspaceIdentifier;
		this.adoptWorkspaceConfiguration();
		return this._workspaceConfiguration.load(this._workspaceIdentifier);
	}

	reload(): Promise<void> {
		return this._workspaceIdentifier ? this.load(this._workspaceIdentifier) : Promise.resolve();
	}

	getFolders(): IStoredWorkspaceFolder[] {
		return this._workspaceConfiguration.getFolders();
	}

	setFolders(folders: IStoredWorkspaceFolder[], jsonEditingService: JSONEditingService): Promise<void> {
		if (this._workspaceIdentifier) {
			return jsonEditingService.write(this._workspaceIdentifier.configPath, { key: 'folders', value: folders }, true)
				.then(() => this.reload());
		}
		return Promise.resolve();
	}

	getConfiguration(): ConfigurationModel {
		return this._workspaceConfiguration.getWorkspaceSettings();
	}

	reprocessWorkspaceSettings(): ConfigurationModel {
		this._workspaceConfiguration.reprocessWorkspaceSettings();
		return this.getConfiguration();
	}

	private adoptWorkspaceConfiguration(): boolean {
		if (this._workspaceIdentifier) {
			if (this._fileService) {
				if (!(this._workspaceConfiguration instanceof FileServiceBasedWorkspaceConfiguration)) {
					const oldWorkspaceConfiguration = this._workspaceConfiguration;
					this._workspaceConfiguration = new FileServiceBasedWorkspaceConfiguration(this._fileService, oldWorkspaceConfiguration);
					this._register(this._workspaceConfiguration.onDidChange(e => this.onDidWorkspaceConfigurationChange()));
					if (oldWorkspaceConfiguration instanceof CachedWorkspaceConfiguration) {
						this.updateCache();
						return true;
					} else {
						dispose(oldWorkspaceConfiguration);
						return false;
					}
				}
				return false;
			}
			if (this._workspaceIdentifier.configPath.scheme === Schemas.file) {
				if (!(this._workspaceConfiguration instanceof NodeBasedWorkspaceConfiguration)) {
					dispose(this._workspaceConfiguration);
					this._workspaceConfiguration = new NodeBasedWorkspaceConfiguration();
					return true;
				}
				return false;
			}
		}
		return false;
	}

	private onDidWorkspaceConfigurationChange(): void {
		this.updateCache();
		this.reload().then(() => this._onDidUpdateConfiguration.fire());
	}

	private updateCache(): Promise<void> {
		if (this._workspaceIdentifier && this._workspaceIdentifier.configPath.scheme !== Schemas.file && this._workspaceConfiguration instanceof FileServiceBasedWorkspaceConfiguration) {
			return this._workspaceConfiguration.load(this._workspaceIdentifier)
				.then(() => this._cachedConfiguration.updateWorkspace(this._workspaceIdentifier!, this._workspaceConfiguration.getConfigurationModel()));
		}
		return Promise.resolve(undefined);
	}
}

interface IWorkspaceConfiguration extends IDisposable {
	readonly onDidChange: Event<void>;
	workspaceConfigurationModelParser: WorkspaceConfigurationModelParser;
	workspaceSettings: ConfigurationModel;
	workspaceIdentifier: IWorkspaceIdentifier | null;
	load(workspaceIdentifier: IWorkspaceIdentifier): Promise<void>;
	getConfigurationModel(): ConfigurationModel;
	getFolders(): IStoredWorkspaceFolder[];
	getWorkspaceSettings(): ConfigurationModel;
	reprocessWorkspaceSettings(): ConfigurationModel;
}

abstract class AbstractWorkspaceConfiguration extends Disposable implements IWorkspaceConfiguration {

	workspaceConfigurationModelParser: WorkspaceConfigurationModelParser;
	workspaceSettings: ConfigurationModel;
	private _workspaceIdentifier: IWorkspaceIdentifier | null = null;

	protected readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(from?: IWorkspaceConfiguration) {
		super();

		this.workspaceConfigurationModelParser = from ? from.workspaceConfigurationModelParser : new WorkspaceConfigurationModelParser('');
		this.workspaceSettings = from ? from.workspaceSettings : new ConfigurationModel();
	}

	get workspaceIdentifier(): IWorkspaceIdentifier | null {
		return this._workspaceIdentifier;
	}

	load(workspaceIdentifier: IWorkspaceIdentifier): Promise<void> {
		this._workspaceIdentifier = workspaceIdentifier;
		return this.loadWorkspaceConfigurationContents(workspaceIdentifier)
			.then(contents => {
				this.workspaceConfigurationModelParser = new WorkspaceConfigurationModelParser(workspaceIdentifier.id);
				this.workspaceConfigurationModelParser.parse(contents);
				this.consolidate();
			});
	}

	getConfigurationModel(): ConfigurationModel {
		return this.workspaceConfigurationModelParser.configurationModel;
	}

	getFolders(): IStoredWorkspaceFolder[] {
		return this.workspaceConfigurationModelParser.folders;
	}

	getWorkspaceSettings(): ConfigurationModel {
		return this.workspaceSettings;
	}

	reprocessWorkspaceSettings(): ConfigurationModel {
		this.workspaceConfigurationModelParser.reprocessWorkspaceSettings();
		this.consolidate();
		return this.getWorkspaceSettings();
	}

	private consolidate(): void {
		this.workspaceSettings = this.workspaceConfigurationModelParser.settingsModel.merge(this.workspaceConfigurationModelParser.launchModel);
	}

	protected abstract loadWorkspaceConfigurationContents(workspaceIdentifier: IWorkspaceIdentifier): Promise<string>;
}

class NodeBasedWorkspaceConfiguration extends AbstractWorkspaceConfiguration {

	protected loadWorkspaceConfigurationContents(workspaceIdentifier: IWorkspaceIdentifier): Promise<string> {
		return pfs.readFile(workspaceIdentifier.configPath.fsPath)
			.then(contents => contents.toString(), e => {
				errors.onUnexpectedError(e);
				return '';
			});
	}

}

class FileServiceBasedWorkspaceConfiguration extends AbstractWorkspaceConfiguration {

	private workspaceConfig: URI | null = null;
	private readonly reloadConfigurationScheduler: RunOnceScheduler;

	constructor(private fileService: IFileService, from?: IWorkspaceConfiguration) {
		super(from);
		this.workspaceConfig = from && from.workspaceIdentifier ? from.workspaceIdentifier.configPath : null;
		this._register(fileService.onFileChanges(e => this.handleWorkspaceFileEvents(e)));
		this.reloadConfigurationScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 50));
		this.watchWorkspaceConfigurationFile();
		this._register(toDisposable(() => this.unWatchWorkspaceConfigurtionFile()));
	}

	private watchWorkspaceConfigurationFile(): void {
		if (this.workspaceConfig) {
			this.fileService.watchFileChanges(this.workspaceConfig);
		}
	}

	private unWatchWorkspaceConfigurtionFile(): void {
		if (this.workspaceConfig) {
			this.fileService.unwatchFileChanges(this.workspaceConfig);
		}
	}

	protected loadWorkspaceConfigurationContents(workspaceIdentifier: IWorkspaceIdentifier): Promise<string> {
		if (!(this.workspaceConfig && resources.isEqual(this.workspaceConfig, workspaceIdentifier.configPath))) {
			this.unWatchWorkspaceConfigurtionFile();
			this.workspaceConfig = workspaceIdentifier.configPath;
			this.watchWorkspaceConfigurationFile();
		}
		return this.fileService.resolveContent(this.workspaceConfig)
			.then(content => content.value, e => {
				errors.onUnexpectedError(e);
				return '';
			});
	}

	private handleWorkspaceFileEvents(event: FileChangesEvent): void {
		if (this.workspaceConfig) {
			const events = event.changes;

			let affectedByChanges = false;
			// Find changes that affect workspace file
			for (let i = 0, len = events.length; i < len && !affectedByChanges; i++) {
				affectedByChanges = resources.isEqual(this.workspaceConfig, events[i].resource);
			}

			if (affectedByChanges) {
				this.reloadConfigurationScheduler.schedule();
			}
		}
	}
}

class CachedWorkspaceConfiguration extends Disposable implements IWorkspaceConfiguration {

	private readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private cachedWorkspacePath: string;
	private cachedConfigurationPath: string;
	workspaceConfigurationModelParser: WorkspaceConfigurationModelParser;
	workspaceSettings: ConfigurationModel;

	constructor(private environmentService: IEnvironmentService) {
		super();
		this.workspaceConfigurationModelParser = new WorkspaceConfigurationModelParser('');
		this.workspaceSettings = new ConfigurationModel();
	}

	load(workspaceIdentifier: IWorkspaceIdentifier): Promise<void> {
		this.createPaths(workspaceIdentifier);
		return pfs.readFile(this.cachedConfigurationPath)
			.then(contents => {
				this.workspaceConfigurationModelParser = new WorkspaceConfigurationModelParser(this.cachedConfigurationPath);
				this.workspaceConfigurationModelParser.parse(contents.toString());
				this.workspaceSettings = this.workspaceConfigurationModelParser.settingsModel.merge(this.workspaceConfigurationModelParser.launchModel);
			}, () => { });
	}

	get workspaceIdentifier(): IWorkspaceIdentifier | null {
		return null;
	}

	getConfigurationModel(): ConfigurationModel {
		return this.workspaceConfigurationModelParser.configurationModel;
	}

	getFolders(): IStoredWorkspaceFolder[] {
		return this.workspaceConfigurationModelParser.folders;
	}

	getWorkspaceSettings(): ConfigurationModel {
		return this.workspaceSettings;
	}

	reprocessWorkspaceSettings(): ConfigurationModel {
		return this.workspaceSettings;
	}

	async updateWorkspace(workspaceIdentifier: IWorkspaceIdentifier, configurationModel: ConfigurationModel): Promise<void> {
		try {
			this.createPaths(workspaceIdentifier);
			if (configurationModel.keys.length) {
				const exists = await pfs.exists(this.cachedWorkspacePath);
				if (!exists) {
					await pfs.mkdirp(this.cachedWorkspacePath);
				}
				const raw = JSON.stringify(configurationModel.toJSON().contents);
				await pfs.writeFile(this.cachedConfigurationPath, raw);
			} else {
				pfs.rimraf(this.cachedWorkspacePath);
			}
		} catch (error) {
			errors.onUnexpectedError(error);
		}
	}

	private createPaths(workspaceIdentifier: IWorkspaceIdentifier) {
		this.cachedWorkspacePath = join(this.environmentService.userDataPath, 'CachedConfigurations', 'workspaces', workspaceIdentifier.id);
		this.cachedConfigurationPath = join(this.cachedWorkspacePath, 'workspace.json');
	}
}

function isFolderConfigurationFile(resource: URI): boolean {
	const configurationNameResource = URI.from({ scheme: resource.scheme, path: resources.basename(resource) });
	return [`${FOLDER_SETTINGS_NAME}.json`, `${TASKS_CONFIGURATION_KEY}.json`, `${LAUNCH_CONFIGURATION_KEY}.json`].some(configurationFileName =>
		resources.isEqual(configurationNameResource, URI.from({ scheme: resource.scheme, path: configurationFileName })));  // only workspace config files
}

function isFolderSettingsConfigurationFile(resource: URI): boolean {
	return resources.isEqual(URI.from({ scheme: resource.scheme, path: resources.basename(resource) }), URI.from({ scheme: resource.scheme, path: `${FOLDER_SETTINGS_NAME}.json` }));
}

export interface IFolderConfiguration extends IDisposable {
	readonly onDidChange: Event<void>;
	readonly loaded: boolean;
	loadConfiguration(): Promise<ConfigurationModel>;
	reprocess(): ConfigurationModel;
}

export abstract class AbstractFolderConfiguration extends Disposable implements IFolderConfiguration {

	private _folderSettingsModelParser: FolderSettingsModelParser;
	private _standAloneConfigurations: ConfigurationModel[];
	private _cache: ConfigurationModel;
	private _loaded: boolean = false;

	protected readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(protected readonly folder: URI, workbenchState: WorkbenchState, from?: AbstractFolderConfiguration) {
		super();

		this._folderSettingsModelParser = from ? from._folderSettingsModelParser : new FolderSettingsModelParser(FOLDER_SETTINGS_PATH, WorkbenchState.WORKSPACE === workbenchState ? [ConfigurationScope.RESOURCE] : [ConfigurationScope.WINDOW, ConfigurationScope.RESOURCE]);
		this._standAloneConfigurations = from ? from._standAloneConfigurations : [];
		this._cache = from ? from._cache : new ConfigurationModel();
	}

	get loaded(): boolean {
		return this._loaded;
	}

	loadConfiguration(): Promise<ConfigurationModel> {
		return this.loadFolderConfigurationContents()
			.then((contents) => {

				// reset
				this._standAloneConfigurations = [];
				this._folderSettingsModelParser.parse('');

				// parse
				this.parseContents(contents);

				// Consolidate (support *.json files in the workspace settings folder)
				this.consolidate();

				this._loaded = true;
				return this._cache;
			});
	}

	reprocess(): ConfigurationModel {
		const oldContents = this._folderSettingsModelParser.configurationModel.contents;
		this._folderSettingsModelParser.reprocess();
		if (!equals(oldContents, this._folderSettingsModelParser.configurationModel.contents)) {
			this.consolidate();
		}
		return this._cache;
	}

	private consolidate(): void {
		this._cache = this._folderSettingsModelParser.configurationModel.merge(...this._standAloneConfigurations);
	}

	private parseContents(contents: { resource: URI, value: string }[]): void {
		for (const content of contents) {
			if (isFolderSettingsConfigurationFile(content.resource)) {
				this._folderSettingsModelParser.parse(content.value);
			} else {
				const name = resources.basename(content.resource);
				const matches = /([^\.]*)*\.json/.exec(name);
				if (matches && matches[1]) {
					const standAloneConfigurationModelParser = new StandaloneConfigurationModelParser(content.resource.toString(), matches[1]);
					standAloneConfigurationModelParser.parse(content.value);
					this._standAloneConfigurations.push(standAloneConfigurationModelParser.configurationModel);
				}
			}
		}
	}

	protected abstract loadFolderConfigurationContents(): Promise<{ resource: URI, value: string }[]>;
}

export class NodeBasedFolderConfiguration extends AbstractFolderConfiguration {

	private readonly folderConfigurationPath: URI;

	constructor(folder: URI, configFolderRelativePath: string, workbenchState: WorkbenchState) {
		super(folder, workbenchState);
		this.folderConfigurationPath = resources.joinPath(folder, configFolderRelativePath);
	}

	protected loadFolderConfigurationContents(): Promise<{ resource: URI, value: string }[]> {
		return this.resolveStat(this.folderConfigurationPath).then(stat => {
			if (!stat.isDirectory || !stat.children) {
				return Promise.resolve([]);
			}
			return this.resolveContents(stat.children.filter(stat => isFolderConfigurationFile(stat.resource))
				.map(stat => stat.resource));
		}, err => [] /* never fail this call */)
			.then(undefined, e => {
				errors.onUnexpectedError(e);
				return [];
			});
	}

	private resolveContents(resources: URI[]): Promise<{ resource: URI, value: string }[]> {
		return Promise.all(resources.map(resource =>
			pfs.readFile(resource.fsPath)
				.then(contents => ({ resource, value: contents.toString() }))));
	}

	private resolveStat(resource: URI): Promise<{ resource: URI, isDirectory?: boolean, children?: { resource: URI; }[] }> {
		return new Promise<{ resource: URI, isDirectory?: boolean, children?: { resource: URI; }[] }>((c, e) => {
			extfs.readdir(resource.fsPath, (error, children) => {
				if (error) {
					if ((<any>error).code === 'ENOTDIR') {
						c({ resource });
					} else {
						e(error);
					}
				} else {
					c({
						resource,
						isDirectory: true,
						children: children.map(child => { return { resource: resources.joinPath(resource, child) }; })
					});
				}
			});
		});
	}
}

export class FileServiceBasedFolderConfiguration extends AbstractFolderConfiguration {

	private reloadConfigurationScheduler: RunOnceScheduler;
	private readonly folderConfigurationPath: URI;
	private readonly loadConfigurationDelayer = new Delayer<Array<{ resource: URI, value: string }>>(50);

	constructor(folder: URI, private configFolderRelativePath: string, workbenchState: WorkbenchState, private fileService: IFileService, from?: AbstractFolderConfiguration) {
		super(folder, workbenchState, from);
		this.folderConfigurationPath = resources.joinPath(folder, configFolderRelativePath);
		this.reloadConfigurationScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 50));
		this._register(fileService.onFileChanges(e => this.handleWorkspaceFileEvents(e)));
	}

	protected loadFolderConfigurationContents(): Promise<Array<{ resource: URI, value: string }>> {
		return Promise.resolve(this.loadConfigurationDelayer.trigger(() => this.doLoadFolderConfigurationContents()));
	}

	private doLoadFolderConfigurationContents(): Promise<Array<{ resource: URI, value: string }>> {
		const workspaceFilePathToConfiguration: { [relativeWorkspacePath: string]: Promise<IContent | undefined> } = Object.create(null);
		const bulkContentFetchromise = Promise.resolve(this.fileService.resolveFile(this.folderConfigurationPath))
			.then(stat => {
				if (stat.isDirectory && stat.children) {
					stat.children
						.filter(child => isFolderConfigurationFile(child.resource))
						.forEach(child => {
							const folderRelativePath = this.toFolderRelativePath(child.resource);
							if (folderRelativePath) {
								workspaceFilePathToConfiguration[folderRelativePath] = Promise.resolve(this.fileService.resolveContent(child.resource)).then(undefined, errors.onUnexpectedError);
							}
						});
				}
			}).then(undefined, err => [] /* never fail this call */);

		return bulkContentFetchromise.then(() => Promise.all<IContent>(collections.values(workspaceFilePathToConfiguration))).then(contents => contents.filter(content => content !== undefined));
	}

	private handleWorkspaceFileEvents(event: FileChangesEvent): void {
		const events = event.changes;
		let affectedByChanges = false;

		// Find changes that affect workspace configuration files
		for (let i = 0, len = events.length; i < len; i++) {
			const resource = events[i].resource;
			const basename = resources.basename(resource);
			const isJson = extname(basename) === '.json';
			const isDeletedSettingsFolder = (events[i].type === FileChangeType.DELETED && basename === this.configFolderRelativePath);

			if (!isJson && !isDeletedSettingsFolder) {
				continue; // only JSON files or the actual settings folder
			}

			const folderRelativePath = this.toFolderRelativePath(resource);
			if (!folderRelativePath) {
				continue; // event is not inside folder
			}

			// Handle case where ".vscode" got deleted
			if (isDeletedSettingsFolder) {
				affectedByChanges = true;
				break;
			}

			// only valid workspace config files
			if (!isFolderConfigurationFile(resource)) {
				continue;
			}

			affectedByChanges = true;
			break;
		}

		if (affectedByChanges) {
			this.reloadConfigurationScheduler.schedule();
		}
	}

	private toFolderRelativePath(resource: URI): string | undefined {
		if (resources.isEqualOrParent(resource, this.folderConfigurationPath)) {
			return resources.relativePath(this.folderConfigurationPath, resource);
		}
		return undefined;
	}
}

export class CachedFolderConfiguration extends Disposable implements IFolderConfiguration {

	private readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly cachedFolderPath: string;
	private readonly cachedConfigurationPath: string;
	private configurationModel: ConfigurationModel;

	loaded: boolean = false;

	constructor(
		folder: URI,
		configFolderRelativePath: string,
		environmentService: IEnvironmentService) {
		super();
		this.cachedFolderPath = join(environmentService.userDataPath, 'CachedConfigurations', 'folders', createHash('md5').update(join(folder.path, configFolderRelativePath)).digest('hex'));
		this.cachedConfigurationPath = join(this.cachedFolderPath, 'configuration.json');
		this.configurationModel = new ConfigurationModel();
	}

	loadConfiguration(): Promise<ConfigurationModel> {
		return pfs.readFile(this.cachedConfigurationPath)
			.then(contents => {
				const parsed: IConfigurationModel = JSON.parse(contents.toString());
				this.configurationModel = new ConfigurationModel(parsed.contents, parsed.keys, parsed.overrides);
				this.loaded = true;
				return this.configurationModel;
			}, () => this.configurationModel);
	}

	updateConfiguration(configurationModel: ConfigurationModel): Promise<void> {
		const raw = JSON.stringify(configurationModel.toJSON());
		return this.createCachedFolder().then(created => {
			if (created) {
				return configurationModel.keys.length ? pfs.writeFile(this.cachedConfigurationPath, raw) : pfs.rimraf(this.cachedFolderPath);
			}
			return undefined;
		});
	}

	reprocess(): ConfigurationModel {
		return this.configurationModel;
	}

	getUnsupportedKeys(): string[] {
		return [];
	}

	private createCachedFolder(): Promise<boolean> {
		return Promise.resolve(pfs.exists(this.cachedFolderPath))
			.then(undefined, () => false)
			.then(exists => exists ? exists : pfs.mkdirp(this.cachedFolderPath).then(() => true, () => false));
	}
}

export class FolderConfiguration extends Disposable implements IFolderConfiguration {

	protected readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private folderConfiguration: IFolderConfiguration;
	private cachedFolderConfiguration: CachedFolderConfiguration;
	private _loaded: boolean = false;

	constructor(
		readonly workspaceFolder: IWorkspaceFolder,
		private readonly configFolderRelativePath: string,
		private readonly workbenchState: WorkbenchState,
		private environmentService: IEnvironmentService,
		fileService?: IFileService
	) {
		super();

		this.cachedFolderConfiguration = new CachedFolderConfiguration(this.workspaceFolder.uri, this.configFolderRelativePath, this.environmentService);
		this.folderConfiguration = this.cachedFolderConfiguration;
		if (fileService) {
			this.folderConfiguration = new FileServiceBasedFolderConfiguration(this.workspaceFolder.uri, this.configFolderRelativePath, this.workbenchState, fileService);
		} else if (this.workspaceFolder.uri.scheme === Schemas.file) {
			this.folderConfiguration = new NodeBasedFolderConfiguration(this.workspaceFolder.uri, this.configFolderRelativePath, this.workbenchState);
		}
		this._register(this.folderConfiguration.onDidChange(e => this.onDidFolderConfigurationChange()));
	}

	loadConfiguration(): Promise<ConfigurationModel> {
		return this.folderConfiguration.loadConfiguration()
			.then(model => {
				this._loaded = this.folderConfiguration.loaded;
				return model;
			});
	}

	reprocess(): ConfigurationModel {
		return this.folderConfiguration.reprocess();
	}

	get loaded(): boolean {
		return this._loaded;
	}

	adopt(fileService: IFileService): Promise<boolean> {
		if (fileService) {
			if (this.folderConfiguration instanceof CachedFolderConfiguration) {
				return this.adoptFromCachedConfiguration(fileService);
			}

			if (this.folderConfiguration instanceof NodeBasedFolderConfiguration) {
				return this.adoptFromNodeBasedConfiguration(fileService);
			}
		}
		return Promise.resolve(false);
	}

	private adoptFromCachedConfiguration(fileService: IFileService): Promise<boolean> {
		const folderConfiguration = new FileServiceBasedFolderConfiguration(this.workspaceFolder.uri, this.configFolderRelativePath, this.workbenchState, fileService);
		return folderConfiguration.loadConfiguration()
			.then(() => {
				this.folderConfiguration = folderConfiguration;
				this._register(this.folderConfiguration.onDidChange(e => this.onDidFolderConfigurationChange()));
				this.updateCache();
				return true;
			});
	}

	private adoptFromNodeBasedConfiguration(fileService: IFileService): Promise<boolean> {
		const oldFolderConfiguration = this.folderConfiguration;
		this.folderConfiguration = new FileServiceBasedFolderConfiguration(this.workspaceFolder.uri, this.configFolderRelativePath, this.workbenchState, fileService, <AbstractFolderConfiguration>oldFolderConfiguration);
		oldFolderConfiguration.dispose();
		this._register(this.folderConfiguration.onDidChange(e => this.onDidFolderConfigurationChange()));
		return Promise.resolve(false);
	}

	private onDidFolderConfigurationChange(): void {
		this.updateCache();
		this._onDidChange.fire();
	}

	private updateCache(): Promise<void> {
		if (this.workspaceFolder.uri.scheme !== Schemas.file && this.folderConfiguration instanceof FileServiceBasedFolderConfiguration) {
			return this.folderConfiguration.loadConfiguration()
				.then(configurationModel => this.cachedFolderConfiguration.updateConfiguration(configurationModel));
		}
		return Promise.resolve(undefined);
	}
}
