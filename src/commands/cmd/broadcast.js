import { RANK } from "../../util/util.js"
import { usageString } from "../commandHandler.js";

export default {
	data: {
		name: "broadcast",
		minRank: RANK.ADMIN,
		usage: 'broadcast <message>',
		hidden: true,
	}, async execute (client, args) {
		if(!args.length) return client.sendMessage({
			sender: 'server',
			type: 'error',
			data: {
				message: usageString(this)
			}
		});
		client.server.broadcastString(args.join(" "));
		client.server.broadcastJSON({
			sender: 'server',
			type: 'raw',
			data:{
				message: args.join(" ")
			}
		});
	}
}