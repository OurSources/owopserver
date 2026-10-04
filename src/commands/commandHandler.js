import path from "path"
import { readdir, rm, symlink, lstat } from "fs/promises"
import { fileURLToPath } from "url"
import { RANK } from "../util/util.js"
import { existsSync } from "fs";

export function handleCommand(client, message) {
	message = message.substring(1);
	let args = message.split(" ");
	let cmdName = args.shift().toLowerCase();
	let cmd = commands.get(cmdName);
	if (!cmd) {
		for (let command of commands.values()) {
			if (!command.data.aliases) continue;
			if (command.data.aliases.includes(cmdName)) {
				cmd = command;
				break;
			}
		}
		if (!cmd){
			const bot = client.world.identifiedBots.get(cmdName);
			if(!bot) return;
			cmd = commands.get('tell');
			args = [bot.uid, ...args];
		}
	}
	if (client.rank < (!!cmd.data.minRank ? cmd.data.minRank : RANK.NONE)) return;
	if (cmd.data.disabled) return;
	if (!cmd.nolog) console.log("client", client.uid, "on", client.world.name, "with ip", client.ip.ip, "executed:", cmd.data.name);
	cmd.execute(client, args);
}

export const commands = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function loadCommands(server, client = null) {
	let cmdPath = path.join(__dirname, "cmd");
	if (server.config.cmdPathOverride) {
		cmdPath = path.join(server.config.cmdPathOverride.src,'commands','cmd');
		// console.info('a cmdpath override was specified. a symlink will be generated.');
		// let srcDir = path.join(server.config.cmdPathOverride.src, 'commands', 'cmd');
		// let targetDir = path.join(process.cwd(), 'cmd');

		// if (existsSync(targetDir)) {
		// 	const so = await lstat(targetDir);
		// 	if (so.isSymbolicLink()) {
		// 		console.log('potentially invalid symlink present. regenerating...');
		// 		try {
		// 			await rm(targetDir, { recursive: false });
		// 		} catch (e) {
		// 			console.error('failed to remove symlink.', e);
		// 			return; // no point in continuing, the symlink may be invalid.
		// 		}
		// 	}
		// }
		// try {
		// 	await symlink(srcDir, targetDir, 'dir');
		// 	console.log('generated symlink.')
		// } catch (e) {
		// 	console.error('failed to generate symlink.', e);
		// 	return;
		// }

		// cmdPath = targetDir;
	}

	commands.clear();
	const commandFiles = await readdir(cmdPath);
	let cmdLoadOk = [];
	for (const file of commandFiles) {
		if (file.endsWith(".js")) {
			try {
				const fullPath = path.join(cmdPath, file);
				const fileUrl = `file://${fullPath}?u=${Date.now()}`;

				const commandModule = await import(fileUrl);
				const command = commandModule.default;

				if (command?.data?.name) {
					commands.set(command.data.name.toLowerCase(), command);
					cmdLoadOk.push(command.data.name);
				}
			} catch (e) {
				console.error(`Failed to load command: ${file}: `, e);
			}
		}
	}
	console.log(`Loaded commands: ${cmdLoadOk.join(', ')}`);
	if (client) {
		// assume commands were reloaded, inform client.
		client.sendMessage({
			sender: 'server',
			type: 'info',
			data: {
				message: `[All commands reloaded]`
			}
		});
	}
}

export function usageString(command) {
	return `Usage: /${command.data.usage}`;
}
