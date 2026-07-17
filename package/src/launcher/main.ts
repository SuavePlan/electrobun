import { join, dirname, resolve } from "path";
import { dlopen, suffix, ptr, toArrayBuffer } from "bun:ffi";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";

// Since main.js now runs from Resources, we need to find libraries in the MacOS directory
const pathToMacOS = dirname(process.argv0); // bun is still in MacOS/bin directory
const coreLibFileName =
	process.platform === "win32"
		? "ElectrobunCore.dll"
		: `libElectrobunCore.${suffix}`;
const coreLibPath = join(pathToMacOS, coreLibFileName);
const absoluteCoreLibPath = resolve(coreLibPath);

// Maximum accepted length for a deep-link URL (defense against oversized argv input).
const MAX_DEEP_LINK_URL_LENGTH = 8 * 1024;

// Return the lowercased extension of a path/URL (without the dot), or "" if none.
function extensionOf(pathOrUrl: string): string {
	const base = pathOrUrl.split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// Extract a launch URL from process arguments (cold launch on Windows/Linux).
// On Windows the OS invokes `"<launcher.exe>" "%1"` from the registry / file association;
// on Linux it invokes `launcher %u` from the .desktop file — in both cases the argument is
// a single argv element. Handles two shapes:
//   - a custom URL scheme deep link (`myapp://...`), matched against the registered schemes;
//   - a file opened via a registered file association, delivered as a path or `file://` URL,
//     matched against the associated extensions and normalized to a `file://` URL.
// The argument is treated as untrusted: only registered schemes / extensions are accepted,
// length is bounded, and control characters are rejected before it reaches app JS.
function extractLaunchUrlFromArgv(
	argv: string[],
	urlSchemes: string[],
	fileExtensions: string[],
): string | null {
	const registeredSchemes = new Set(urlSchemes.map((s) => s.toLowerCase()));
	const exts = new Set(fileExtensions.map((e) => e.toLowerCase()));
	if (registeredSchemes.size === 0 && exts.size === 0) return null;
	// argv[0] is the launcher executable; user-supplied arguments follow.
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg || arg.length > MAX_DEEP_LINK_URL_LENGTH) continue;
		// eslint-disable-next-line no-control-regex
		if (/[\u0000-\u001f\u007f]/.test(arg)) continue;
		const match = arg.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//);
		if (match) {
			const scheme = match[1]!.toLowerCase();
			// Custom URL scheme deep link.
			if (registeredSchemes.has(scheme)) return arg;
			// A file:// URL from the OS — accept if its extension is associated.
			if (scheme === "file" && exts.size > 0) {
				try {
					if (exts.has(extensionOf(fileURLToPath(arg)))) return arg;
				} catch {
					/* not a valid file URL — ignore */
				}
			}
			continue;
		}

		// Not a URL: a plain file path from a file association. Require the extension to be
		// associated and the file to exist, then normalize to a file:// URL.
		if (exts.size > 0 && exts.has(extensionOf(arg)) && existsSync(arg)) {
			return pathToFileURL(arg).href;
		}
	}
	return null;
}

// Wrap main logic in a function to avoid top-level return
function main() {
	// Read version.json early to get identifier, name, and channel for CEF initialization
	let channel = "";
	let identifier = "";
	let name = "";
	let urlSchemes: string[] = [];
	let fileExtensions: string[] = [];
	let singleInstance = false;
	try {
		const pathToLauncherBin = process.argv0;
		const pathToBinDir = dirname(pathToLauncherBin);
		const versionJsonPath = join(
			pathToBinDir,
			"..",
			"Resources",
			"version.json",
		);

		if (existsSync(versionJsonPath)) {
			const versionInfo = JSON.parse(readFileSync(versionJsonPath, "utf8"));
			if (versionInfo.identifier) {
				identifier = versionInfo.identifier;
			}
			if (versionInfo.name) {
				name = versionInfo.name;
			}
			if (versionInfo.channel) {
				channel = versionInfo.channel;
			}
			if (Array.isArray(versionInfo.urlSchemes)) {
				urlSchemes = versionInfo.urlSchemes.filter(
					(s: unknown): s is string => typeof s === "string",
				);
			}
			if (Array.isArray(versionInfo.fileExtensions)) {
				fileExtensions = versionInfo.fileExtensions.filter(
					(s: unknown): s is string => typeof s === "string",
				);
			}
			if (typeof versionInfo.singleInstance === "boolean") {
				singleInstance = versionInfo.singleInstance;
			}
			console.log(
				`[LAUNCHER] Loaded identifier: ${identifier}, name: ${name}, channel: ${channel}`,
			);
		}
	} catch (error) {
		console.error(`[LAUNCHER] Warning: Could not read version.json:`, error);
		// Continue anyway - this is not critical for dev builds
	}

	// Check for CEF libraries and warn if LD_PRELOAD not set (Linux only)
	if (process.platform === "linux") {
		const cefLibs = [
			join(pathToMacOS, "libcef.so"),
			join(pathToMacOS, "libvk_swiftshader.so"),
		];
		const existingCefLibs = cefLibs.filter((lib) => existsSync(lib));

		if (existingCefLibs.length > 0 && !process.env["LD_PRELOAD"]) {
			console.error(
				`[LAUNCHER] ERROR: CEF libraries found but LD_PRELOAD not set!`,
			);
			console.error(
				`[LAUNCHER] Please run through the wrapper script: ./run.sh`,
			);
			console.error(
				`[LAUNCHER] Or set: LD_PRELOAD="${existingCefLibs.join(":")}" before starting.`,
			);

			// Try to re-exec ourselves with LD_PRELOAD set
			const env = { ...process.env, LD_PRELOAD: existingCefLibs.join(":") };
			const child = spawn(process.argv[0]!, process.argv.slice(1), {
				env,
				stdio: "inherit",
			});
			child.on("exit", (code: number | null) => process.exit(code ?? 1));
			return; // Don't continue in this process
		}
	}

	// FFI surface of libElectrobunCore that the launcher needs. Deep-link + single-instance
	// entry points are forwarded by the core shim to libNativeWrapper (see core/main.zig).
	const coreSymbols = {
		electrobun_core_run_main_thread: {
			args: ["cstring", "cstring", "cstring", "i32"],
			returns: "i32",
		},
		electrobun_core_last_error: {
			args: [],
			returns: "cstring",
		},
		// Cold-launch deep link: hand a URL received as an argv element to the native
		// wrapper, which buffers it until the Bun worker registers its open-url handler.
		electrobun_set_launch_url: {
			args: ["cstring"],
			returns: "void",
		},
		// First-run deep-link registration (Windows registry). No-op on other platforms.
		electrobun_register_url_schemes: {
			args: ["cstring", "cstring"],
			returns: "void",
		},
		// First-run file-association registration (Windows registry). No-op elsewhere.
		electrobun_register_file_associations: {
			args: ["cstring", "cstring", "cstring"],
			returns: "void",
		},
		// Single-instance: acquire returns true for the primary (first) instance, false for
		// a secondary. send_url forwards a deep-link URL from a secondary to the primary.
		electrobun_single_instance_acquire: {
			args: ["cstring"],
			returns: "bool",
		},
		electrobun_single_instance_send_url: {
			args: ["cstring", "cstring"],
			returns: "void",
		},
		// Signal the running primary that the app was relaunched with no URL (reopen).
		electrobun_single_instance_send_reopen: {
			args: ["cstring"],
			returns: "void",
		},
	} as const;

	let lib;
	try {
		// Set LD_LIBRARY_PATH if not already set
		if (!process.env["LD_LIBRARY_PATH"]?.includes(".")) {
			process.env["LD_LIBRARY_PATH"] =
				`.${process.env["LD_LIBRARY_PATH"] ? ":" + process.env["LD_LIBRARY_PATH"] : ""}`;
		}

		lib = dlopen(coreLibPath, coreSymbols);
	} catch (error) {
		console.error(
			`[LAUNCHER] Failed to load ElectrobunCore: ${(error as Error).message}`,
		);

		// Try with absolute path as fallback
		try {
			lib = dlopen(absoluteCoreLibPath, coreSymbols);
		} catch (absError) {
			console.error(
				`[LAUNCHER] Core library loading failed. Try running: ldd ${coreLibPath}`,
			);
			throw error;
		}
	}

	// Single-instance + warm-launch deep-link forwarding (Windows/Linux).
	// If another instance already holds the lock, this is a secondary launch: forward any
	// deep-link URL from our arguments to the running instance (delivered there via the
	// "open-url" event) and exit without opening a second window. macOS is inherently
	// single-instance for bundled apps and routes deep links via the OS, so it is skipped.
	if (process.platform !== "darwin" && singleInstance) {
		const instanceKey = `electrobun.${identifier}.${channel}`;
		// Keep the backing buffer referenced by name so it isn't GC'd between FFI calls.
		const instanceKeyBytes = new Uint8Array(
			Buffer.from(instanceKey + "\0", "utf8"),
		);
		const isPrimary = lib.symbols.electrobun_single_instance_acquire(
			ptr(instanceKeyBytes),
		);
		if (!isPrimary) {
			const forwardUrl = extractLaunchUrlFromArgv(process.argv, urlSchemes, fileExtensions);
			if (forwardUrl) {
				console.log(`[LAUNCHER] Forwarding deep link to running instance`);
				lib.symbols.electrobun_single_instance_send_url(
					ptr(instanceKeyBytes),
					ptr(new Uint8Array(Buffer.from(forwardUrl + "\0", "utf8"))),
				);
			} else {
				// No URL: ask the running instance to surface itself (reopen).
				console.log(
					`[LAUNCHER] Another instance is already running; requesting reopen`,
				);
				lib.symbols.electrobun_single_instance_send_reopen(
					ptr(instanceKeyBytes),
				);
			}
			process.exit(0);
		}
	}

	// todo (yoav): as the debug launcher, get the relative path a different way, so dev builds can be shared and executed
	// from different locations
	const pathToLauncherBin = process.argv0;
	const pathToBinDir = dirname(pathToLauncherBin);

	const resourcesDir = join(pathToBinDir, "..", "Resources");
	const asarPath = join(resourcesDir, "app.asar");
	const appFolderPath = join(resourcesDir, "app");

	let appEntrypointPath: string;

	// Check if ASAR archive exists
	if (existsSync(asarPath)) {
		console.log(`[LAUNCHER] Loading app code from ASAR: ${asarPath}`);

		// Load ASAR functions via FFI
		// Use standalone libasar in the bundle on every platform.
		let asarLibPath: string;
		let asarLib: any;

		if (process.platform === "win32") {
			const nativeWrapperAsarLibPath = join(pathToMacOS, "libNativeWrapper.dll");
			asarLibPath = existsSync(nativeWrapperAsarLibPath)
				? nativeWrapperAsarLibPath
				: join(pathToMacOS, "libasar.dll");
		} else {
			asarLibPath = join(pathToMacOS, `libasar.${suffix}`);
		}

		try {
			asarLib = dlopen(asarLibPath, {
				asar_open: { args: ["cstring"], returns: "ptr" },
				asar_read_file: { args: ["ptr", "cstring", "ptr"], returns: "ptr" },
				asar_free_buffer: { args: ["ptr", "u64"], returns: "void" },
				asar_close: { args: ["ptr"], returns: "void" },
			});
		} catch (error) {
			console.error(
				`[LAUNCHER] Failed to load ASAR library: ${(error as Error).message}`,
			);
			throw error;
		}

		// Open ASAR archive
		const asarArchive = asarLib.symbols.asar_open(
			ptr(new Uint8Array(Buffer.from(asarPath + "\0", "utf8"))),
		);

		if (!asarArchive || asarArchive === 0n) {
			console.error(`[LAUNCHER] Failed to open ASAR archive at: ${asarPath}`);
			throw new Error("Failed to open ASAR archive");
		}

		// Read bun/index.js from ASAR
		const filePath = "bun/index.js";
		const sizeBuffer = new BigUint64Array(1);
		const fileDataPtr = asarLib.symbols.asar_read_file(
			asarArchive,
			ptr(new Uint8Array(Buffer.from(filePath + "\0", "utf8"))),
			ptr(sizeBuffer),
		);

		if (!fileDataPtr || fileDataPtr === 0n) {
			console.error(`[LAUNCHER] Failed to read ${filePath} from ASAR`);
			asarLib.symbols.asar_close(asarArchive);
			throw new Error(`Failed to read ${filePath} from ASAR`);
		}

		const fileSize = Number(sizeBuffer[0]);
		console.log(`[LAUNCHER] Read ${fileSize} bytes from ASAR for ${filePath}`);

		// Copy data from the FFI pointer to a Buffer using toArrayBuffer
		const arrayBuffer = toArrayBuffer(fileDataPtr, 0, fileSize);
		const fileData = Buffer.from(arrayBuffer);

		// Write to system temp directory with randomized filename for security
		const systemTmpDir = tmpdir();
		const randomFileName = `electrobun-${Date.now()}-${Math.random().toString(36).substring(7)}.js`;
		appEntrypointPath = join(systemTmpDir, randomFileName);

		// Prepend code to delete the temp file after a short delay
		// This runs in the Worker thread, not the main thread (which gets blocked by startEventLoop)
		const wrappedFileData = `
// Auto-delete temp file after Worker loads it
const __tempFilePath = "${appEntrypointPath}";
setTimeout(() => {
    try {
        if (globalThis.cottontail?.unlinkSync) {
            globalThis.cottontail.unlinkSync(__tempFilePath);
        } else if (typeof require === "function") {
            require("fs").unlinkSync(__tempFilePath);
        }
        console.log("[LAUNCHER] Deleted temp file:", __tempFilePath);
    } catch (error) {
        console.warn("[LAUNCHER] Failed to delete temp file:", error.message);
    }
}, 100);

${fileData.toString("utf8")}
`;

		writeFileSync(appEntrypointPath, wrappedFileData);
		console.log(`[LAUNCHER] Wrote app entrypoint to: ${appEntrypointPath}`);

		// Free the buffer
		asarLib.symbols.asar_free_buffer(fileDataPtr, BigInt(fileSize));

		// Close the archive
		asarLib.symbols.asar_close(asarArchive);
	} else {
		// Fallback to flat file system (for non-ASAR builds)
		console.log(`[LAUNCHER] Loading app code from flat files`);
		appEntrypointPath = join(appFolderPath, "bun", "index.js");
	}

	// Register signal handlers on the main thread to prevent default termination.
	// The worker thread's SIGINT handler will call quit() for graceful shutdown.
	// Without these, SIGINT kills the process before the worker can run beforeQuit.
	process.on("SIGINT", () => {});
	process.on("SIGTERM", () => {});

	// First-run deep-link registration (Windows): register custom URL schemes in the
	// registry so the OS routes `<scheme>://` links to this app. Idempotent and self-healing
	// (uses the current launcher path). macOS registers via Info.plist at build time; Linux
	// registers at install time via the .desktop file + xdg-mime.
	if (process.platform === "win32" && urlSchemes.length > 0) {
		try {
			lib.symbols.electrobun_register_url_schemes(
				ptr(new Uint8Array(Buffer.from(urlSchemes.join(",") + "\0", "utf8"))),
				ptr(new Uint8Array(Buffer.from(process.execPath + "\0", "utf8"))),
			);
		} catch (err) {
			console.error(`[LAUNCHER] URL scheme registration failed:`, err);
		}
	}

	// First-run file-association registration (Windows): register per-extension ProgIDs so
	// double-clicking an associated file opens this app. Self-healing (current launcher path).
	// macOS registers via Info.plist; Linux registers at install time via MIME + xdg-mime.
	if (process.platform === "win32" && fileExtensions.length > 0) {
		try {
			lib.symbols.electrobun_register_file_associations(
				ptr(new Uint8Array(Buffer.from(identifier + "\0", "utf8"))),
				ptr(new Uint8Array(Buffer.from(fileExtensions.join(",") + "\0", "utf8"))),
				ptr(new Uint8Array(Buffer.from(process.execPath + "\0", "utf8"))),
			);
		} catch (err) {
			console.error(`[LAUNCHER] File association registration failed:`, err);
		}
	}

	// Cold-launch deep link (Windows/Linux): if the OS launched us with a registered
	// scheme URL as an argument, hand it to the native wrapper. It is buffered there and
	// delivered to the app's "open-url" listener once the worker registers its handler.
	// macOS receives deep links through the app delegate (application:openURLs:) instead.
	if (process.platform !== "darwin") {
		const launchUrl = extractLaunchUrlFromArgv(process.argv, urlSchemes, fileExtensions);
		if (launchUrl) {
			console.log(`[LAUNCHER] Cold-launch deep link received`);
			lib.symbols.electrobun_set_launch_url(
				ptr(new Uint8Array(Buffer.from(launchUrl + "\0", "utf8"))),
			);
		}
	}

	new Worker(appEntrypointPath, {
		// consider adding a preload with error handling
		// preload: [''];
	});

	const runStatus = lib.symbols.electrobun_core_run_main_thread(
		ptr(new Uint8Array(Buffer.from(identifier + "\0", "utf8"))),
		ptr(new Uint8Array(Buffer.from(name + "\0", "utf8"))),
		ptr(new Uint8Array(Buffer.from(channel + "\0", "utf8"))),
		0,
	);

	if (runStatus !== 0) {
		const coreError = lib.symbols.electrobun_core_last_error();
		console.error(
			`[LAUNCHER] ElectrobunCore failed: ${coreError ? coreError.toString() : "Unknown error"}`,
		);
		process.exit(runStatus);
	}
}

// Call the main function
main();
