import type { Readable } from 'stream';
import * as os from "os";
import * as fsp from 'fs/promises';
import * as semver from 'semver';
import * as crypto from "crypto";
import path from 'path';
import { createReadStream, createWriteStream } from "fs";
import { exec, spawn } from "child_process";
import { program } from 'commander';
import FormData from 'form-data';
import fetch, { Headers } from 'node-fetch';
import archiver from "archiver";

//@ts-ignore
import readdirGlob from 'readdir-glob';

import type { FileSystem, FileType } from 'vscode';
import { URI, Utils } from 'vscode-uri';
import { applyEdits, Edit } from "jsonc-parser";
import * as jsonc from "jsonc-parser";

import type { ModInfo } from "./vscode/ModPackageProvider";
import { ModManager, BundledMods } from './ModManager';
import { ModSettings } from './ModSettings';
import { ActiveFactorioVersion, FactorioVersion } from "./vscode/FactorioVersion";

import { displayName, version as bundleVersion } from "../package.json";

const fsAccessor:  Pick<FileSystem, "readFile"|"writeFile"|"stat"> = {
	async readFile(uri:URI) {
		return fsp.readFile(uri.fsPath);
	},
	async writeFile(uri:URI, content:Buffer) {
		return fsp.writeFile(uri.fsPath, content);
	},
	async stat(uri:URI) {
		const stat = await fsp.stat(uri.fsPath);

		return {
			size: stat.size,
			// eslint-disable-next-line no-bitwise
			type: (stat.isFile() ? <FileType>1 : 0) |
				(stat.isDirectory() ? <FileType>2 : 0) |
				(stat.isSymbolicLink() ? <FileType>64 : 0),
			ctime: stat.ctime.valueOf(),
			mtime: stat.mtime.valueOf(),
		};
	},
};

async function getConfig<T extends {}>(section:string, defaults:T):Promise<T> {
	return Object.assign(
		defaults,
		await new Promise((resolve)=>{
			if (process.send) {
				const gotconfig = (msg:{cmd:string;section:string;config:{}})=>{
					if (msg.cmd === "config" && msg.section === section) {
						resolve(msg.config);
					}
					process.off("message", gotconfig);
				};
				process.on("message", gotconfig);
				process.send({cmd: "getConfig", section: section});
			} else {
				resolve(undefined);
			}
		})
	);
}

async function getConfigGetter<T extends {}>(section:string, defaults:T) {
	const config = await getConfig(section, defaults);
	return {
		get: function<K extends keyof T>(key:K, defaultValue?:T[K]) {
			return config[key] ?? defaultValue;
		},
	};
}

const modscommand = program.command("mods")
	.description("Mod management commands")
	.option("--modsPath <modsPath>", "mods directory to operate on", process.cwd());
modscommand.command("enable <modname> [version]")
	.description("Enable a mod or select a specific version of it")
	.action(async (modname:string, version?:string)=>{
		const manager = new ModManager(modscommand.opts().modsPath);
		await manager.Loaded;
		manager.set(modname, version??true);
		await manager.write();
	});
modscommand.command("disable <modname>")
	.description("Disable a mod")
	.action(async (modname:string)=>{
		const manager = new ModManager(modscommand.opts().modsPath);
		await manager.Loaded;
		manager.set(modname, false);
		await manager.write();
	});
modscommand.command("install <modname>")
	.description(`Install a mod. Currently only supports bundled mods: ${Object.keys(BundledMods)}`)
	.option("--keepOld", "Don't remove old versions if present")
	.action(async (modname:string, options:{keepOld?:boolean})=>{
		const manager = new ModManager(modscommand.opts().modsPath);
		await manager.Loaded;
		console.log(await manager.installMod(modname, ["bundle"], options.keepOld));
	});
modscommand.command("adjust <changes...>")
	.description("Configure multiple mods at once: modname=true|false|x.y.z")
	.option("--allowDisableBase", "Allow disabling the base mod")
	.option("--disableExtra", "Disable any mods not named in the changeset")
	.action(async (changes:string[], options:{allowDisableBase?:boolean; disableExtra?:boolean})=>{
		const manager = new ModManager(modscommand.opts().modsPath);
		await manager.Loaded;
		if (options.disableExtra) {
			console.log(`All Mods disabled`);
			manager.disableAll();
		}
		for (const change of changes) {
			const match = change.match(/^(.*)=(true|false|(?:\d+\.){2}\d+)$/);
			if (!match) {
				console.log(`Doing nothing with invalid adjust arg "${change}"`);
			} else {
				const mod = match[1];
				const adjust =
					match[2] ==="true" ? true :
					match[2] ==="false" ? false :
					match[2];
				manager.set(mod, adjust);
				console.log(`${mod} ${
					adjust === true ? "enabled" :
					adjust === false ? "disabled" :
					"enabled version " + adjust
				}`);
			}
		}

		if (!options.allowDisableBase) { manager.set("base", true); }
		try {
			await manager.write();
		} catch (error) {
			console.log(`Failed to save mod list:\n${error}`);
		}
	});

const settingscommand = program.command("settings")
	.description("Edit mod settings")
	.option("--modsPath <modsPath>", "mods directory to operate on", process.cwd());
settingscommand.command("list")
	.description("List all current saved values")
	.action(async ()=>{
		const modSettingsUri = Utils.joinPath(URI.file(settingscommand.opts().modsPath), "mod-settings.dat");
		const settings = new ModSettings(Buffer.from(await fsp.readFile(modSettingsUri.fsPath)));
		for (const setting of settings.list()) {
			console.log(`${setting.scope} ${setting.setting} ${typeof setting.value==="string"?`"${setting.value}"`:setting.value}`);
		}
	});
settingscommand.command("get <scope> <name>")
	.description("Get the saved value of a setting")
	.action(async (scope:string, name:string)=>{
		switch (scope) {
			case "startup":
			case "runtime-global":
			case "runtime-per-user":
				break;
			default:
				console.log(`Unknown scope "${scope}"`);
				return;
		}
		const modSettingsUri = Utils.joinPath(URI.file(settingscommand.opts().modsPath), "mod-settings.dat");
		const settings = new ModSettings(Buffer.from(await fsp.readFile(modSettingsUri.fsPath)));
		const value = settings.get(scope, name);
		console.log(`${typeof value==="string"?`"${value}"`:value}`);
	});
settingscommand.command("set <scope> <name> <value>")
	.description("Set the saved value of a setting")
	.action(async (scope:string, name:string, value:string)=>{
		switch (scope) {
			case "startup":
			case "runtime-global":
			case "runtime-per-user":
				break;
			default:
				console.log(`Unknown scope "${scope}"`);
				return;
		}
		const modSettingsUri = Utils.joinPath(URI.file(settingscommand.opts().modsPath), "mod-settings.dat");
		const settings = new ModSettings(Buffer.from(await fsp.readFile(modSettingsUri.fsPath)));
		if (value === "true" || value ==="false") {
			settings.set(scope, name, value==="true");
		} else {
			const numValue = Number(value);
			if (!isNaN(numValue) && value!=="") {
				settings.set(scope, name, numValue);
			} else {
				settings.set(scope, name, value);
			}
		}
		await fsp.writeFile(modSettingsUri.fsPath, settings.save());
	});

async function getPackageinfo() {
	try {
		return JSON.parse(await fsp.readFile("info.json", "utf8")) as ModInfo;
	} catch (error) {
		console.log(`Failed to read info.json: ${error}`);
		process.exit(1);
	}

}

async function runPackageScript(scriptname:string, info:ModInfo, env?:{}) {
	return new Promise<number>(async (resolve, reject)=>{
		const script = info.package?.scripts?.[scriptname];
		if (script) {
			const proc = spawn(script, {
				shell: true,
				windowsHide: true,
				stdio: "inherit",
				env: Object.assign({}, process.env, {
					FACTORIO_MODNAME: info.name,
					FACTORIO_MODVERSION: info.version,
					// if windows users use wsl bash, pass our env through to there too...
					WSLENV: (process.env.WSLENV?process.env.WSLENV+":":"") + "FACTORIO_MODNAME/u:FACTORIO_MODVERSION/u:FACTORIO_MODPACKAGE/p",
				}, env),
			});
			proc.on('error', reject);
			proc.on("close", (code, signal)=>{
				if (code !== null) {
					resolve(code);
				} else {
					reject(signal);
				}
			});
		} else {
			reject(new Error(`No script '${scriptname}'`));
		}
	});
}

async function runPackageGitCommand(command:string, stdin?:string) {
	return new Promise<void>(async (resolve, reject)=>{
		const proc = spawn(`git ${command}`, {
			shell: true,
			windowsHide: true,
			stdio:
				stdin !== undefined ? ["pipe", 'inherit', 'inherit'] :
				"inherit",
		});
		if (stdin !== undefined && proc.stdin) {
			proc.stdin.write(stdin);
			proc.stdin.end();
		}
		proc.on('error', reject);
		proc.on("close", (code, signal)=>{
			if (code === 0) {
				resolve();
			} else if (code !== null) {
				reject(code);
			} else {
				reject(signal);
			}
		});
	});
}

async function doPackageDatestamp(info:ModInfo): Promise<boolean> {
	const uri = Utils.joinPath(URI.file(process.cwd()), "changelog.txt");
	let content:string|undefined;
	try {
		content = await fsp.readFile("changelog.txt", "utf8");
	} catch (error) {}
	if (!content) {
		console.log("No changelog.txt");
	} else {
		const { TextDocument } = await import("vscode-languageserver-textdocument");
		const { ChangeLogLanguageService } = await import("./Language/ChangeLog");
		const doc = TextDocument.create(uri.toString(), "factorio-changelog", 1, content);
		const langserv = new ChangeLogLanguageService();
		const syms = langserv.onDocumentSymbol(doc);

		const current = syms?.find(sym=>sym.name.startsWith(info.version))!;
		if (current) {
			const date = current.children?.find(sym=>sym.name === "Date");
			let edit:Edit;
			if (date) {
				edit = {
					content: new Date().toISOString().substr(0, 10),
					offset: doc.offsetAt(date.selectionRange.start),
					length: date.selectionRange.end.character - date.selectionRange.start.character,
				};
			} else {
				edit = {
					content: `\nDate: ${new Date().toISOString().substr(0, 10)}`,
					offset: doc.offsetAt(current.selectionRange.end),
					length: 0,
				};
			}
			content = applyEdits(content, [edit]);
			fsp.writeFile("changelog.txt", content);
			console.log(`Changelog section ${info.version} stamped ${new Date().toISOString().substr(0, 10)}`);
		} else {
			console.log(`No Changelog section for ${info.version}`);
		}
	}

	if (info.package?.scripts?.datestamp) {
		const code = await runPackageScript("datestamp", info);
		if (code !== 0) {
			process.exit(code);
		}
	}
	return !!content;
}

async function doPackageZip(info:ModInfo): Promise<archiver.Archiver> {
	if (info.package?.scripts?.compile) {
		const code = await runPackageScript("compile", info);
		if (code !== 0) {
			process.exit(code);
		}
	}

	if (info.package?.scripts?.prepackage) {
		const code = await runPackageScript("prepackage", info);
		if (code !== 0) {
			process.exit(code);
		}
	}

	const archive = archiver('zip', { zlib: { level: 9 }});
	archive.glob("**", {
		cwd: process.cwd(),
		root: process.cwd(),
		nodir: true,
		ignore: [`**/${info.name}_*.zip`].concat(info.package?.ignore||[]),
	}, { prefix: `${info.name}_${info.version}` });

	if (info.package?.extra) {
		for (const extra of info.package.extra) {
			archive.glob(extra.glob ?? "**", {
				cwd: extra.root,
				root: extra.root,
				nodir: true,
				ignore: extra.ignore,
			}, { prefix: `${info.name}_${info.version}` });
		}
	}

	return archive;
}

interface PortalError {
	error:"InvalidApiKey"|"InvalidRequest"|"InternalError"|"Forbidden"|"Unknown"|"InvalidModRelease"|"InvalidModUpload"|"UnknownMod"
	message:string
}

async function doPackageUpload(packagestream:Readable|Buffer, name:string) {
	const APIKey = process.env["FACTORIO_UPLOAD_API_KEY"];

	if (!APIKey) { throw new Error("No API Key"); }

	const headers = new Headers({
		"Authorization": `Bearer ${APIKey}`,
	});
	console.log(`Uploading to mod portal...`);
	const init_form = new FormData();
	init_form.append("mod", name);
	const init_result = await fetch("https://mods.factorio.com/api/v2/mods/releases/init_upload", {
		method: "POST",
		body: init_form,
		headers: headers,
	});
	if (!init_result.ok) {
		console.log(`init_upload failed: ${init_result.status} ${init_result.statusText}'`);
		throw new Error(init_result.statusText);
	}
	const init_json = <{upload_url:string}|PortalError> await init_result.json();

	if ('error' in init_json) {
		console.log(`init_upload failed: ${init_json.error} ${init_json.message}'`);
		throw new Error(init_json.error);
	}

	const finish_form = new FormData();
	finish_form.append(
		"file",
		packagestream,
		{
			filename: `${name}.zip`,
			contentType: 'application/x-zip-compressed',
		});
	const finish_result = await fetch(init_json.upload_url, {
		method: "POST",
		body: finish_form,
		headers: headers,
	});
	if (!finish_result.ok) {
		console.log(`finish_upload failed: ${finish_result.status} ${finish_result.statusText}'`);
		throw new Error(finish_result.statusText);
	}
	const finish_json = <{success:true}|PortalError> await finish_result.json();
	if ('error' in finish_json) {
		console.log(`finish_upload failed: ${finish_json.error} ${finish_json.message}'`);
		throw new Error(finish_json.error);
	}
	console.log(`Published ${name}`);
	return;
}

async function doPackageVersion(info:ModInfo, json:string) {
	const newversion = semver.inc(info.version, 'patch', {"loose": true})!;
	const edits = jsonc.modify(json, ["version"], newversion, {});
	await fsp.writeFile("info.json", applyEdits(json, edits));
	info.version = newversion;

	await fsp.readFile("changelog.txt", "utf8")
		.catch(()=>undefined)
		.then(async (changelog)=>{
			if (changelog) {
				const useCR = changelog.indexOf("\r\n")!==-1;
				const n = useCR ? "\r\n" : "\n";
				await fsp.writeFile("changelog.txt",
					`---------------------------------------------------------------------------------------------------${n}` +
					`Version: ${newversion}${n}` +
					`Date: ????${n}` +
					`  Changes:${n}` +
					changelog);
			}
		});

	if (info.package?.scripts?.version) {
		const code = await runPackageScript("version", info);
		if (code !== 0) {
			process.exit(code);
		}
	}
	return info;
}

program.command("run <script>")
	.description("Run a script from info.json#/package/scripts")
	.action(async (scriptname:string)=>{
		process.exit(await runPackageScript(scriptname, await getPackageinfo()));
	});

program.command("datestamp")
	.description("Datestamp the current changelog section")
	.action(async ()=>{
		const info = await getPackageinfo();
		await doPackageDatestamp(info);
	});

program.command("version")
	.description("Increment the mod version")
	.action(async ()=>{
		const json = await fsp.readFile("info.json", "utf8");
		const info = JSON.parse(json) as ModInfo;
		await doPackageVersion(info, json);
	});


program.command("package")
	.description("Build a zip package")
	.option("--outdir <outdir>", "", "")
	.action(async (options)=>{
		const info = await getPackageinfo();
		const zipuri = Utils.resolvePath(URI.file(process.cwd()), options.outdir, `${info.name}_${info.version}.zip`);
		const zipoutput = createWriteStream(zipuri.fsPath);
		const zip = await doPackageZip(info);
		zip.pipe(zipoutput);
		await zip.finalize();
		console.log(`Built ${info.name}_${info.version}.zip ${zip.pointer()} bytes`);
	});

program.command("upload <zipname> [name]")
	.description("Upload a zip package to the mod portal")
	.action(async (zipname:string, name?:string)=>{

		if (!name) {
			const basename = path.basename(zipname, ".zip");
			const match = basename.match(/^(.*?)(_(\d+\.){2}\d+)?$/);
			if (match) {
				name = match[1];
			}
		}

		if (!name) {
			console.log("Unable to determine `name`");
			return;
		}

		const packagezip = createReadStream(zipname);
		await doPackageUpload(packagezip, name);
	});

program.command("publish")
	.description("Package and publish a mod to the mod portal")
	.action(async ()=>{
		const json = await fsp.readFile("info.json", "utf8");
		const info = JSON.parse(json) as ModInfo;

		console.log(`Publishing: ${process.cwd()} ${info.version}`);

		//when launched from vscode, transfer config over, otherwise defaults
		const config:{
			preparingCommitMessage:string
			movedToCommitMessage:string
			autoCommitAuthor:string
			tagName: string
			tagMessage?: string
		} = await getConfig("package", {
			preparingCommitMessage: "preparing release of version $VERSION",
			movedToCommitMessage: "moved to version $VERSION",
			autoCommitAuthor: "compilatron <compilatron@justarandomgeek.com>",
			tagName: "$VERSION",
			tagMessage: undefined,
		});

		const repoStatus = await new Promise((resolve)=>{
			exec("git status --porcelain", (error, stdout, stderr)=>{
				if (error && error.code !== 0) {
					resolve(undefined); // no repo
				}
				if (stdout) {
					resolve("HasChanges");
				}
				resolve("OK");
			});
		});

		let branchname:string;
		if (repoStatus) {
			// throw if uncommitted changes
			if (repoStatus==="HasChanges") {
				console.log("Cannot Publish with uncommitted changes");
				return;
			}
			branchname = await new Promise((resolve, reject)=>{
				exec("git branch --show-current", (error, stdout)=>{
					if (error && error.code !== 0) {
						reject(error);
					}
					resolve(stdout.trim());
				});
			});
			let expectedBranch = info.package?.git_publish_branch;
			switch (expectedBranch) {
				case null:
					// null -> no check
					break;

				//@ts-expect-error fallthrough
				case undefined:
					// undefined -> check equal to `git config init.defaultBranch`
					expectedBranch = await new Promise((resolve, reject)=>{
						exec("git config init.defaultBranch", (error, stdout)=>{
							if (error && error.code !== 0) {
								reject(error);
							}
							resolve(stdout.trim());
						});
					});
				default:
					// string -> check equal to
					// throw if not on publish branch
					if (expectedBranch !== branchname) {
						console.log(`Cannot Publish on branch other than '${expectedBranch}', currently on '${branchname}'`);
						process.exit(1);
					}
					break;
			}
		} else {
			console.log("No git repo found, skipping git subtasks...");
		}

		if (info.package?.scripts?.prepublish) {
			const code = await runPackageScript("prepublish", info);
			if (code !== 0) {
				process.exit(code);
			}
		}

		const haschangelog = await doPackageDatestamp(info);

		let tagname:string|undefined;
		if (repoStatus) {
			if (haschangelog) { await runPackageGitCommand(`add changelog.txt`); }
			await runPackageGitCommand(
				`commit --author "${ config.autoCommitAuthor }" --allow-empty -F -`,
				config.preparingCommitMessage.replace(/\$VERSION/g, info.version).replace(/\$MODNAME/g, info.name));

			if (!info.package?.no_git_tag) {
				tagname = config.tagName.replace(/\$VERSION/g, info.version).replace(/\$MODNAME/g, info.name);
				const tagmessage = config.tagMessage?.replace(/\$VERSION/g, info.version).replace(/\$MODNAME/g, info.name);
				await runPackageGitCommand(`tag -a ${tagname} -F -`, tagmessage ?? "");
			}
		}

		// build zip with <factorio.package>
		const zipbuffer = await new Promise<Buffer>(async (resolve, reject)=>{
			const zip = await doPackageZip(info);
			const chunks:Buffer[] = [];
			zip.on('data', (chunk)=>chunks.push(Buffer.from(chunk)));
			zip.on('error', (err)=>reject(err));
			zip.on('end', ()=>resolve(Buffer.concat(chunks)));
			await zip.finalize();
		});

		if (info.package?.scripts?.publish) {
			const code = await runPackageScript("publish", info);
			if (code !== 0) {
				process.exit(code);
			}
		}

		if (!info.package?.no_portal_upload) {
			await doPackageUpload(zipbuffer, info.name);
		}

		if (info.package?.scripts?.postpublish) {
			const packagepath = path.join(os.tmpdir(), `${crypto.randomBytes(16).toString('base64url')}.zip`);
			await fsp.writeFile(packagepath, zipbuffer);
			const code = await runPackageScript("postpublish", info, {
				FACTORIO_MODPACKAGE: packagepath,
			});
			await fsp.unlink(packagepath);
			if (code !== 0) {
				process.exit(code);
			}
		}

		const newinfo = await doPackageVersion(info, json);
		if (repoStatus) {
			await runPackageGitCommand(`add info.json`);
			if (haschangelog) { await runPackageGitCommand(`add changelog.txt`); }
			await runPackageGitCommand(
				`commit --author "${ config.autoCommitAuthor }" -F -`,
				config.movedToCommitMessage.replace(/\$VERSION/g, newinfo.version).replace(/\$MODNAME/g, newinfo.name));

			if (!info.package?.no_git_push) {
				const upstream = await new Promise((resolve)=>{
					exec(`git config branch.${branchname}.remote`, (error, stdout)=>{
						if (error && error.code !== 0) {
							resolve(undefined);
						}
						resolve(stdout.trim());
					});
				});
				if (upstream) {
					await runPackageGitCommand(`push ${upstream} ${branchname!} ${tagname ?? ""}`);
				} else {
					console.log(`no remote set as upstream on ${branchname!}`);
				}
			}
		}
	});

program.command("sumneko-3rd [outdir]")
	.description("Generate a library bundle for sumneko.lua LSP")
	.option("-d, --docs <docsjson>", "Include runtime docs")
	.action(async (outdir:string|undefined, options:{docs?:string})=>{
		await Promise.all((await (await import("./Sumneko3rd")).default()).map(async (file)=>{
			const filepath = path.join(outdir ?? process.cwd(), file.name);
			await fsp.mkdir(path.dirname(filepath), { recursive: true });
			return fsp.writeFile(filepath, Buffer.from(file.content));
		}));
		if (options.docs) {
			await docscommand(options.docs, path.join(outdir ?? process.cwd(), "factorio", "library"));
		}
	});

program.command("docs <docjson> <outdir>")
	.description("Generate runtime api docs for sumneko.lua LSP")
	.action(docscommand);
async function docscommand(docjson:string, outdir:string) {
	const { ApiDocGenerator } = await import('./ApiDocs/ApiDocGenerator');
	const docs = new ApiDocGenerator((await fsp.readFile(docjson, "utf8")).toString(), await getConfigGetter("doc", {}));
	await fsp.mkdir(outdir, { recursive: true });
	await docs.generate_sumneko_docs(async (filename:string, buff:Buffer)=>{
		await fsp.writeFile(path.join(outdir, filename), buff);
	});
};


//vscode-languageserver handles these arguments
program.command("lsp")
	.description("Run LSP Server for Locale and Changelog features")
	.allowUnknownOption(true).allowExcessArguments(true)
	.action(async ()=>{
		const { runLanguageServer } = await import("./Language/Server");
		runLanguageServer();
	});

program.command("debug <factorioPath>")
	.description("Launch a DAP debug session")
	.option("-d, --docs <docsPath>", "path to runtime-api.json")
	.option("-c, --config <configPath>", "path to config.ini")
	.option("-w, --workspace <workspacePath...>", "path to workspace folders")
	.action(async (factorioPath:string, options:{docs?:string; config?:string; workspace?:string[]})=>{
		const fv: FactorioVersion = {
			name: "standalone",
			factorioPath: factorioPath,
			configPath: options.config,
			docsPath: options.docs,
		};
		const docsPath = Utils.joinPath(URI.file(factorioPath),
			fv.docsPath ? fv.docsPath :
			(os.platform() === "darwin") ? "../../doc-html/runtime-api.json" :
			"../../../doc-html/runtime-api.json"
		);
		const docsjson = await fsp.readFile(docsPath.fsPath, "utf8");
		const { ApiDocGenerator } = await import('./ApiDocs/ApiDocGenerator');
		const activeVersion = new ActiveFactorioVersion(fsAccessor, fv, new ApiDocGenerator(docsjson, await getConfigGetter("doc", {})));

		// start a single session that communicates via stdin/stdout
		const { FactorioModDebugSession } = await import('./Debug/factorioModDebug');
		const session = new FactorioModDebugSession(activeVersion, fsAccessor, {
			async findWorkspaceFiles(include) {
				const found:URI[] = [];
				for (const folder of options.workspace ?? [process.cwd()]) {
					const globber = readdirGlob(folder, {pattern: include});
					globber.on('match', (match:{ relative:string; absolute:string })=>{
						found.push(URI.file(match.absolute));
					});
					globber.on('error', (err:unknown)=>{
						throw err;
					});
					await new Promise<void>((resolve)=>{
						globber.on('end', ()=>{
							resolve();
						});
					});
				}
				return found;
			},
		});
		process.on('SIGTERM', ()=>{
			session.shutdown();
		});
		session.start(process.stdin, process.stdout);
	});

program
	.description(`${displayName} ${bundleVersion}`)
	.addHelpCommand()
	.showHelpAfterError()
	.showSuggestionAfterError()
	// when launched by vscode-pretending-to-be-node this detects electron
	// but has node-style args, so force it...
	.parseAsync(process.argv, {from: "node"})
	.catch((err)=>{
		console.error(err);
	})
	.then(()=>{
		// close IPC if it was open from parent...
		if (process.send && !program.args.includes("lsp")) {
			process.disconnect();
		}
	});