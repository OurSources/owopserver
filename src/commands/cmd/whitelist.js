import { RANK } from "../../util/util.js";
import { usageString } from "../commandHandler.js";

export default {
	data: {
		name: 'whitelist',
		description: 'Adds a user to the whitelist.',
		usage: 'whitelist (<clear>/<add/remove/check> <ip>)',
		aliases: [],
		minRank: RANK.ADMIN,
	},
	async execute(client, args){
		if(!args.length) return client.sendMessage({
			sender: 'server',
			type: 'error',
			data: {
				message: usageString(this)
			}
		});
		let type = args[0].toLowerCase();
		if(type==="clear"){
			client.server.resetWhitelist();
			return client.sendMessage({
				sender: 'server',
				type: 'info',
				data: {
					message: `Cleared whitelist.`	
				}
			});
		}
		if(type==="add"){
			if(!args[1]) return client.sendMessage({
				sender: 'server',
				type: 'error',
				data: {
					message: usageString(this)
				}
			});
			let target = await client.server.ips.fetch(args[1]);
			if(!target) return client.sendMessage({
				sender: 'server',
				type: 'error',
				data: {
					message: `IP not found. Usage: /${this.data.usage}`
				}
			});
			target.setProp("whitelist",client.server.whitelistId);
			return client.sendMessage({
				sender: 'server',
				type: 'info',
				data: {
					message: `Added ${target.ip} to whitelist.`
				}
			});
		}
		if(type==="remove"){
			if(!args[1]) return client.sendMessage({
				sender: 'server',
				type: 'error',
				data: {
					message: usageString(this)
				}
			});
			let target = await client.server.ips.fetch(args[1]);
			if(!target) return client.sendMessage({
				sender: 'server',
				type: 'error',
				data: {
					message: `IP not found. Usage: /${this.data.usage}`
				}
			});
			target.setProp("whitelist",-1);
			return client.sendMessage({
				sender: 'server',
				type: 'info',
				data: {
					message: `Removed ${target.ip} from whitelist.`
				}
			});
		}
		if(type==="check"){
			if(!args[1]) return client.sendMessage({
				sender: 'server',
				type: 'error',
				data: {
					message: usageString(this)
				}
			});
			let target = await client.server.ips.fetch(args[1]);
			if(!target) return client.sendMessage({
				sender: 'server',
				type: 'error',
				data: {
					message: `IP not found. Usage: /${this.data.usage}`
				}
			});
			return client.sendMessage({
				sender: 'server',
				type: 'info',
				data: {
					message: `IP ${target.ip} is ${target.whitelist===client.server.whitelistId?"whitelisted":"not whitelisted"}.`
				}
			});
		}
	}
}