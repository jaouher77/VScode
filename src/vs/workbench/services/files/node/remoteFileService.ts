/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNonEmptyArray } from 'vs/base/common/arrays';
import { IDisposable, dispose, Disposable } from 'vs/base/common/lifecycle';
import { TernarySearchTree } from 'vs/base/common/map';
import { Schemas } from 'vs/base/common/network';
import * as resources from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { IDecodeStreamOptions, toDecodeStream, encodeStream } from 'vs/base/node/encoding';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/resourceConfiguration';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { FileOperation, FileOperationError, FileOperationEvent, FileOperationResult, FileWriteOptions, FileSystemProviderCapabilities, IContent, ICreateFileOptions, IFileStat, IFileSystemProvider, IFilesConfiguration, IResolveContentOptions, IResolveFileOptions, IResolveFileResult, IStat, IStreamContent, ITextSnapshot, IUpdateContentOptions, StringSnapshot, IWatchOptions, FileType, ILegacyFileService, IFileService, toFileOperationResult, IFileStatWithMetadata, IResolveMetadataFileOptions, etag } from 'vs/platform/files/common/files';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { FileService } from 'vs/workbench/services/files/node/fileService';
import { createReadableOfProvider, createReadableOfSnapshot, createWritableOfProvider } from 'vs/workbench/services/files/node/streams';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';

class TypeOnlyStat implements IStat {

	constructor(readonly type: FileType) {
		//
	}

	// todo@remote -> make a getter and warn when
	// being used in development.
	mtime: number = 0;
	ctime: number = 0;
	size: number = 0;
}

function toIFileStat(provider: IFileSystemProvider, tuple: [URI, IStat], recurse?: (tuple: [URI, IStat]) => boolean): Promise<IFileStat> {
	const [resource, stat] = tuple;
	const fileStat: IFileStat = {
		resource,
		name: resources.basename(resource),
		isDirectory: (stat.type & FileType.Directory) !== 0,
		isSymbolicLink: (stat.type & FileType.SymbolicLink) !== 0,
		isReadonly: !!(provider.capabilities & FileSystemProviderCapabilities.Readonly),
		mtime: stat.mtime,
		size: stat.size,
		etag: etag(stat.mtime, stat.size),
	};

	if (fileStat.isDirectory) {
		if (recurse && recurse([resource, stat])) {
			// dir -> resolve
			return provider.readdir(resource).then(entries => {
				// resolve children if requested
				return Promise.all(entries.map(tuple => {
					const [name, type] = tuple;
					const childResource = resources.joinPath(resource, name);
					return toIFileStat(provider, [childResource, new TypeOnlyStat(type)], recurse);
				})).then(children => {
					fileStat.children = children;
					return fileStat;
				});
			});
		}
	}

	// file or (un-resolved) dir
	return Promise.resolve(fileStat);
}

export function toDeepIFileStat(provider: IFileSystemProvider, tuple: [URI, IStat], to?: URI[]): Promise<IFileStat> {

	const trie = TernarySearchTree.forPaths<true>();
	trie.set(tuple[0].toString(), true);

	if (isNonEmptyArray(to)) {
		to.forEach(uri => trie.set(uri.toString(), true));
	}

	return toIFileStat(provider, tuple, candidate => {
		return Boolean(trie.findSuperstr(candidate[0].toString()) || trie.get(candidate[0].toString()));
	});
}

class WorkspaceWatchLogic extends Disposable {

	private _watches = new Map<string, URI>();

	constructor(
		private _fileService: RemoteFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
	) {
		super();

		this._refresh();

		this._register(this._contextService.onDidChangeWorkspaceFolders(e => {
			for (const removed of e.removed) {
				this._unwatchWorkspace(removed.uri);
			}
			for (const added of e.added) {
				this._watchWorkspace(added.uri);
			}
		}));
		this._register(this._contextService.onDidChangeWorkbenchState(e => {
			this._refresh();
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('files.watcherExclude')) {
				this._refresh();
			}
		}));
	}

	dispose(): void {
		this._unwatchWorkspaces();
		super.dispose();
	}

	private _refresh(): void {
		this._unwatchWorkspaces();
		for (const folder of this._contextService.getWorkspace().folders) {
			if (folder.uri.scheme !== Schemas.file) {
				this._watchWorkspace(folder.uri);
			}
		}
	}

	private _watchWorkspace(resource: URI) {
		let excludes: string[] = [];
		let config = this._configurationService.getValue<IFilesConfiguration>({ resource });
		if (config.files && config.files.watcherExclude) {
			for (const key in config.files.watcherExclude) {
				if (config.files.watcherExclude[key] === true) {
					excludes.push(key);
				}
			}
		}
		this._watches.set(resource.toString(), resource);
		this._fileService.watchFileChanges(resource, { recursive: true, excludes });
	}

	private _unwatchWorkspace(resource: URI) {
		if (this._watches.has(resource.toString())) {
			this._fileService.unwatchFileChanges(resource);
			this._watches.delete(resource.toString());
		}
	}

	private _unwatchWorkspaces() {
		this._watches.forEach(uri => this._fileService.unwatchFileChanges(uri));
		this._watches.clear();
	}
}

export class RemoteFileService extends FileService {

	private readonly _provider: Map<string, IFileSystemProvider>;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IStorageService storageService: IStorageService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@INotificationService notificationService: INotificationService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
	) {
		super(
			contextService,
			environmentService,
			textResourceConfigurationService,
			configurationService,
			lifecycleService,
			storageService,
			notificationService
		);

		this._provider = new Map<string, IFileSystemProvider>();
		this._register(new WorkspaceWatchLogic(this, configurationService, contextService));
	}

	registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
		if (this._provider.has(scheme)) {
			throw new Error('a provider for that scheme is already registered');
		}

		this._provider.set(scheme, provider);

		return {
			dispose: () => {
				this._provider.delete(scheme);
			}
		};
	}

	// --- stat

	private _withProvider(resource: URI): Promise<IFileSystemProvider> {

		if (!resources.isAbsolutePath(resource)) {
			throw new FileOperationError(
				localize('invalidPath', "The path of resource '{0}' must be absolute", resource.toString(true)),
				FileOperationResult.FILE_INVALID_PATH
			);
		}

		return Promise.all([
			this._fileService.activateProvider(resource.scheme)
		]).then(() => {
			const provider = this._provider.get(resource.scheme);
			if (!provider) {
				const err = new Error();
				err.name = 'ENOPRO';
				err.message = `no provider for ${resource.toString()}`;
				throw err;
			}
			return provider;
		});
	}

	resolveFile(resource: URI, options: IResolveMetadataFileOptions): Promise<IFileStatWithMetadata>;
	resolveFile(resource: URI, options?: IResolveFileOptions): Promise<IFileStat>;
	resolveFile(resource: URI, options?: IResolveFileOptions): Promise<IFileStat> {
		if (resource.scheme === Schemas.file) {
			return super.resolveFile(resource, options);
		} else {
			return this._doResolveFiles([{ resource, options }]).then(data => {
				if (data.length !== 1 || !data[0].success) {
					throw new FileOperationError(
						localize('fileNotFoundError', "File not found ({0})", resource.toString(true)),
						FileOperationResult.FILE_NOT_FOUND
					);
				} else {
					return data[0].stat!;
				}
			});
		}
	}

	private _doResolveFiles(toResolve: { resource: URI; options?: IResolveFileOptions; }[]): Promise<IResolveFileResult[]> {
		return this._withProvider(toResolve[0].resource).then(provider => {
			let result: IResolveFileResult[] = [];
			let promises = toResolve.map((item, idx) => {
				return provider.stat(item.resource).then(stat => {
					return toDeepIFileStat(provider, [item.resource, stat], item.options && item.options.resolveTo).then(fileStat => {
						result[idx] = { stat: fileStat, success: true };
					});
				}, _err => {
					result[idx] = { stat: undefined, success: false };
				});
			});
			return Promise.all(promises).then(() => result);
		});
	}

	// --- resolve

	resolveContent(resource: URI, options?: IResolveContentOptions): Promise<IContent> {
		if (resource.scheme === Schemas.file) {
			return super.resolveContent(resource, options);
		} else {
			return this._readFile(resource, options).then(RemoteFileService._asContent);
		}
	}

	resolveStreamContent(resource: URI, options?: IResolveContentOptions): Promise<IStreamContent> {
		if (resource.scheme === Schemas.file) {
			return super.resolveStreamContent(resource, options);
		} else {
			return this._readFile(resource, options);
		}
	}

	private _readFile(resource: URI, options: IResolveContentOptions = Object.create(null)): Promise<IStreamContent> {
		return this._withProvider(resource).then(provider => {

			return this.resolveFile(resource).then(fileStat => {

				if (fileStat.isDirectory) {
					// todo@joh cannot copy a folder
					// https://github.com/Microsoft/vscode/issues/41547
					throw new FileOperationError(
						localize('fileIsDirectoryError', "File is directory"),
						FileOperationResult.FILE_IS_DIRECTORY,
						options
					);
				}
				if (fileStat.etag === options.etag) {
					throw new FileOperationError(
						localize('fileNotModifiedError', "File not modified since"),
						FileOperationResult.FILE_NOT_MODIFIED_SINCE,
						options
					);
				}

				const decodeStreamOpts: IDecodeStreamOptions = {
					guessEncoding: options.autoGuessEncoding,
					overwriteEncoding: detected => {
						return this.encoding.getReadEncoding(resource, options, { encoding: detected, seemsBinary: false });
					}
				};

				const readable = createReadableOfProvider(provider, resource, options.position || 0);

				return toDecodeStream(readable, decodeStreamOpts).then(data => {

					if (options.acceptTextOnly && data.detected.seemsBinary) {
						return Promise.reject<any>(new FileOperationError(
							localize('fileBinaryError', "File seems to be binary and cannot be opened as text"),
							FileOperationResult.FILE_IS_BINARY,
							options
						));
					}

					return <IStreamContent>{
						encoding: data.detected.encoding,
						value: data.stream,
						resource: fileStat.resource,
						name: fileStat.name,
						etag: fileStat.etag,
						mtime: fileStat.mtime,
						isReadonly: fileStat.isReadonly,
						size: fileStat.size
					};
				});
			});
		});
	}

	// --- saving

	private static async _mkdirp(provider: IFileSystemProvider, directory: URI): Promise<void> {

		let basenames: string[] = [];
		while (directory.path !== '/') {
			try {
				let stat = await provider.stat(directory);
				if ((stat.type & FileType.Directory) === 0) {
					throw new Error(`${directory.toString()} is not a directory`);
				}
				break; // we have hit a directory -> good
			} catch (e) {
				// ENOENT
				basenames.push(resources.basename(directory));
				directory = resources.dirname(directory);
			}
		}
		for (let i = basenames.length - 1; i >= 0; i--) {
			directory = resources.joinPath(directory, basenames[i]);
			await provider.mkdir(directory);
		}
	}

	private static _throwIfFileSystemIsReadonly(provider: IFileSystemProvider): IFileSystemProvider {
		if (provider.capabilities & FileSystemProviderCapabilities.Readonly) {
			throw new FileOperationError(localize('err.readonly', "Resource can not be modified."), FileOperationResult.FILE_PERMISSION_DENIED);
		}
		return provider;
	}

	createFile(resource: URI, content?: string, options?: ICreateFileOptions): Promise<IFileStatWithMetadata> {
		if (resource.scheme === Schemas.file) {
			return super.createFile(resource, content, options);
		} else {

			return this._withProvider(resource).then(RemoteFileService._throwIfFileSystemIsReadonly).then(provider => {

				return RemoteFileService._mkdirp(provider, resources.dirname(resource)).then(() => {
					const { encoding } = this.encoding.getWriteEncoding(resource);
					return this._writeFile(provider, resource, new StringSnapshot(content || ''), encoding, { create: true, overwrite: Boolean(options && options.overwrite) });
				});

			}).then(fileStat => {
				this._onAfterOperation.fire(new FileOperationEvent(resource, FileOperation.CREATE, fileStat));
				return fileStat;
			}, err => {
				const message = localize('err.create', "Failed to create file {0}", resource.toString(false));
				const result = toFileOperationResult(err);
				throw new FileOperationError(message, result, options);
			});
		}
	}

	updateContent(resource: URI, value: string | ITextSnapshot, options?: IUpdateContentOptions): Promise<IFileStatWithMetadata> {
		if (resource.scheme === Schemas.file) {
			return super.updateContent(resource, value, options);
		} else {
			return this._withProvider(resource).then(RemoteFileService._throwIfFileSystemIsReadonly).then(provider => {
				return RemoteFileService._mkdirp(provider, resources.dirname(resource)).then(() => {
					const snapshot = typeof value === 'string' ? new StringSnapshot(value) : value;
					return this._writeFile(provider, resource, snapshot, options && options.encoding, { create: true, overwrite: true });
				});
			});
		}
	}

	private _writeFile(provider: IFileSystemProvider, resource: URI, snapshot: ITextSnapshot, preferredEncoding: string | undefined = undefined, options: FileWriteOptions): Promise<IFileStatWithMetadata> {
		const readable = createReadableOfSnapshot(snapshot);
		const { encoding, hasBOM } = this.encoding.getWriteEncoding(resource, preferredEncoding);
		const encoder = encodeStream(encoding, { addBOM: hasBOM });
		const target = createWritableOfProvider(provider, resource, options);
		return new Promise((resolve, reject) => {
			readable.pipe(encoder).pipe(target);
			target.once('error', err => reject(err));
			target.once('finish', (_: unknown) => resolve(undefined));
		}).then(_ => {
			return this.resolveFile(resource, { resolveMetadata: true }) as Promise<IFileStatWithMetadata>;
		});
	}

	private static _asContent(content: IStreamContent): Promise<IContent> {
		return new Promise<IContent>((resolve, reject) => {
			let result: IContent = {
				value: '',
				encoding: content.encoding,
				etag: content.etag,
				size: content.size,
				mtime: content.mtime,
				name: content.name,
				resource: content.resource,
				isReadonly: content.isReadonly
			};
			content.value.on('data', chunk => result.value += chunk);
			content.value.on('error', reject);
			content.value.on('end', () => resolve(result));
		});
	}

	private _activeWatches = new Map<string, { unwatch: Promise<IDisposable>, count: number }>();

	watchFileChanges(resource: URI, opts: IWatchOptions = { recursive: false, excludes: [] }): void {
		if (resource.scheme === Schemas.file) {
			return super.watchFileChanges(resource);
		}

		const key = resource.toString();
		const entry = this._activeWatches.get(key);
		if (entry) {
			entry.count += 1;
			return;
		}

		this._activeWatches.set(key, {
			count: 1,
			unwatch: this._withProvider(resource).then(provider => {
				return provider.watch(resource, opts);
			}, _err => {
				return { dispose() { } };
			})
		});
	}

	unwatchFileChanges(resource: URI): void {
		if (resource.scheme === Schemas.file) {
			return super.unwatchFileChanges(resource);
		}
		let entry = this._activeWatches.get(resource.toString());
		if (entry && --entry.count === 0) {
			entry.unwatch.then(dispose);
			this._activeWatches.delete(resource.toString());
		}
	}
}

registerSingleton(ILegacyFileService, RemoteFileService);