import { RANK, validateQuotaString } from "../../util/util.js";

export default {
	data: {
		name: 'config',
		description: 'view or edit config options',
		usage: 'config <option> [value]',
		aliases: ['cfg'],
		minRank: RANK.ADMIN,
	}, async execute(client, args){
		let keys = Object.keys(client.server.config);
		let usagemsg = `${this.data.usage} (valid options: ${keys.join(", ")})`;
		if(!args.length) return client.sendMessage({
			sender: 'server',
			type: 'error',
			data: {
				message: `Usage: /${this.data.usage}`	
			}
		});
		let option = args[0];
		for(let key of keys){
			if(key.toLowerCase()===option.toLowerCase()){
				if(!args[1]) return client.sendMessage({
					sender: 'server',
					type: 'info',
					data:{
						message: `Current value of ${key}: ${client.server.config[key]}`
					}
				});
				let value = args[1];
				let parsed;
				switch(key){
					case "defaultPquota":
						if(!validateQuotaString(value)) return client.sendMessage({
							sender: 'server',
							type: 'error',
							data: {
								message: `Invalid value. Must be formatted as AMOUNT,RATE. Cannot be greated than 65535 or less than 0.`
							}
						});
						client.server.config[key] = value;
						break;
					case "captchaSecurity":
						parsed = parseInt(value);
						if(!(parsed>=0&&parsed<=3)) return client.sendMessage({
							sender: 'server',
							type: 'error',
							data: {
								message: `Invalid value. Must be between 0 and 2. (0=disabled, 1=enabled once per ip, 2=always enabled)`	
							}
						});
						client.server.config[key] = parsed;
						break;
					case "maxConnectionsPerIp":
						parsed = parseInt(value);
						if(!(parsed>0)) return client.sendMessage({
							sender: 'server',
							type: 'error',
							data: {
								message: `Invalid value. Must be greater than 0.`
							}
						});
						client.server.config[key] = parsed;
						break;
					case "motd":
						value = args.slice(1).join(" ");
						client.server.config[key] = value;
						break;
					case "appealMessage":
						value = args.slice(1).join(" ");
						client.server.config[key] = value;
						break;
					case "regionLoadQuota":
						if(!validateQuotaString(value)) return client.sendMessage({
							sender: 'server',
							type: 'error',
							data: {
								message: `Invalid value. Must be formatted as AMOUNT,RATE. Cannot be greated than 65535 or less than 0.`
							}
						});
						client.server.config[key] = value;
						break;
					default:
						return client.sendMessage({
							sender: 'server',
							type: 'error',
							data: {
								message: `No setter is defined for ${key}.`
							}
						});
				}
				return client.sendMessage({
					sender: 'server',
					type: 'info',
					data: {
						message: `Set ${key} to ${parsed || value}.`
					}
				});
			}
		}
		client.sendMessage({
			sender: 'server',
			type: 'error',
			data: {
				message: `Invalid option. Usage: /${this.data.usage}`
			}
		});
	}
}