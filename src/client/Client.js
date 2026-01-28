import { Quota } from "../util/Quota.js"
import { verifyCaptchaToken, formatDuration } from "../util/util.js"
import { handleCommand } from "../commands/commandHandler.js"

let textEncoder = new TextEncoder()
let textDecoder = new TextDecoder()

let minChunkCoord = ~0xFFFFF
let maxChunkCoord = 0xFFFFF

let minPixelCoord = ~0xFFFFFF
let maxPixelCoord = 0xFFFFFF

let maxMessageLengths = [
	128,
	128,
	512,
	Infinity //16384
]

export class Client {
	constructor(serverClientManager, ws, id) {
		this.serverClientManager = serverClientManager
		this.server = serverClientManager.server
		this.id = id
		this.ws = ws
		this.ip = ws.ip
		this.chatFormat = ws.format;

		this.geoData = ws.extra.geoData;

		this.ip.addClient(this)

		this.lastUpdate = null
		this.connectionTick = this.server.currentTick
		this.rank = 0
		// this is the rank to apply after the user joined the world, before the protocol state fully initializes...
		this.preJoinRank = 0
		this.world = null
		this.uid = null
		let pquota = this.server.config.defaultPquota.split(",").map(value => parseInt(value))
		this.pquota = new Quota(pquota[0], pquota[1])
		this.protectquota = new Quota(5000, 7)
		this.pquota.deplete()
		this.cquota = new Quota(4, 6)
		this.regionloadquota = new Quota(350, 5)
		this.captchaState = null
		this.joiningWorld = false
		this.nick = null
		this.noPasteTold = false
		this.sentX = 0
		this.sentY = 0
		this.x = 0
		this.y = 0
		this.r = 0
		this.g = 0
		this.b = 0
		this.tool = 0
		this.updated = false
		this.mute = false
		this.stealth = false

		// Donation-related properties
		this.prate = pquota[0];
		this.pper = pquota[1];
		this.pmult = this.server.getDonationMultiplier();

		//action lengths:
		//1: load
		//2: protect
		//4: erase
		//5: pixel
		//769: paste
		//deferring actions like this is kind of a weird thing to do, but my hope is that reducing async/await usage can help performance
		this.deferredRegionActions = new Map()
		this.deferredAmount = 0

		this.destroyed = false
	}

	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		this.defeerredRegionActions = null
		if (!this.ws.closed) this.ws.end()
		if (this.world) this.world.removeClient(this)
		this.ip.removeClient(this)
		this.serverClientManager.clientDestroyed(this)
	}

	keepAlive(tick) {
		if (!this.world) return tick - this.connectionTick < 9000 //10 minutes (time to solve captcha)
		if (this.rank >= 3) return true
		return tick - this.lastUpdate < 18000 //20 minutes
	}

	sendBuffer(buffer) {
		this.ws.send(buffer.buffer, true)
	}

	// sendString(string) {
	// 	this.ws.send(textEncoder.encode(string).buffer, false)
	// }

	// Send JSON message to client.
	sendMessage(message){
		// V2 MESSAGE FORMAT:
		// {
		// 	sender: 'server', // sender determines initial logic path, valid options are 'server' or 'player'.
		// 	// type determines further logic branching, if sender is 'server', valid options are 'info', 'error', 'raw', 'whisper'.
		// 	// if sender is 'player', valid options are 'message', 'broadcast', 'whisperSent', and 'whisperReceived'.
		// 	type: 'info',
		// 	data: {
		// 		allowHTML: false, // allow HTML to be parsed.
		// 		classNameOverride: null, // enforce a class name onto the message object instead of whatever the client logic dictates.
		// 		rank: this.rank, // rank of the sender, should just use Client.rank.
		// 		isBot: this.isBot, // is this a bot message? Should just use Client.isBot.
		// 		action: null, // arbitrary action for logic flow on client. Typically does extra things instead of branching path.
		// 		nick: this.nick, // nickname of sender. Should use Client.nick, or to update nickname, use 'updateNick' action and supply new nickname here.
		// 		message, // message to be output in chat.
		// 		targetID: null, // the target ID of this message, if applicable.
		// 		senderID: this.uid, // ID of the sender, if applicable.
		// 		showLoading: false, // for 'updateStatus' action, whether or not to show the loading gif.
		// 	}
		// }
		// console.log(message);
		if(this.chatFormat==="v2") this.ws.send(JSON.stringify(message), false);
		else{ // majestic compatibility mode :D
			let textToSend = null;
			if (!message.data) return; // oh no
			switch (message.sender + "-" + message.type) {
				case "server-whisperSent":
					textToSend = `-> You tell ${message.data.targetID}: ${message.data.message}`;
					break;

				case "player-whisperReceived":
					textToSend = `-> ${message.data.senderID} tells you: ${message.data.message}`;
					break;
			}

			if(!textToSend && !!message.data && !!message.data.message){
				textToSend = message.data.message;
			}

			if (textToSend) this.ws.send(textEncoder.encode(textToSend).buffer, false);
			// send nothing if no text was magicked up. client will have to do parsing bullshit and guesswork to figure out things like if password was correct or when to update nick.
		}
	}

	getNick() {
		if (this.nick) {
			if (this.rank === 3) return this.nick
			if (this.rank === 2) return `${this.world.modPrefix.value} ${this.nick}`
			return `[${this.uid}] ${this.nick}`
		}
		if (this.rank === 3) return `(A) ${this.uid}`
		if (this.rank === 2) return `${this.world.modPrefix.value} ${this.uid}`
		return this.uid.toString()
	}

	setUid(id) {
		this.uid = id
    console.log(`new client! ${id} (${this.ip.ip}/${this.world.name})`);
		let buffer = Buffer.allocUnsafeSlow(5)
		buffer[0] = 0x00
		buffer.writeUint32LE(id, 1);
		this.sendBuffer(buffer)
	}

	setPquota(amount, seconds) {
		// Store original values for donation multiplier calculations
		this.prate = amount;
		this.pper = seconds;

		// Apply donation multiplier to the rate before setting params
		let multAmount = Math.floor(amount * this.pmult);
		this.pquota.setParams(multAmount, seconds);

		let buffer = Buffer.allocUnsafeSlow(6)
		buffer[0] = 0x06
		buffer.writeUint16LE(multAmount, 1)
		buffer.writeUint16LE(seconds, 3)
		buffer[5] = Math.min(Math.round(this.pmult * 10.0), 255.0); // pmult_i
		this.sendBuffer(buffer)
	}

	getRank() {
		return this.world ? this.rank : this.preJoinRank;
	}

	setRank(rank) {
		if (!this.world) {
			this.preJoinRank = rank;
			return
		}
		if (rank === this.rank) return
		if (rank === 3) {
			this.ws.subscribe(this.server.adminTopic)
		} else if (this.rank === 3 && rank < 3) {
			this.ws.unsubscribe(this.server.adminTopic)
		}
		if (rank >= 2) {
			this.ws.subscribe(this.world.staffTopic)
		} else if (this.rank >= 2 && rank < 2) {
			this.ws.unsubscribe(this.world.staffTopic)
		}
		let pquota
		if (this.world.pquota.value) {
			pquota = this.world.pquota.value
		} else {
			pquota = this.server.config.defaultPquota
		}
		pquota = pquota.split(",").map(value => parseInt(value))
		switch (rank) {
			case 0: {
				pquota[0] = 0
				break
			}
			case 2: {
				if (this.world.doubleModPquota.value) pquota[1] = Math.ceil(pquota[1] / 2)
				break
			}
			case 3: {
				pquota[1] = 0
				break
			}
		}
		this.setPquota(pquota[0], pquota[1])
		this.rank = rank
		console.log(`got rank! ${this.uid} - rank ${rank} (${this.ip.ip}/${this.world.name})`);
		let buffer = Buffer.allocUnsafeSlow(2)
		buffer[0] = 0x04
		buffer[1] = rank
		this.sendBuffer(buffer)
		if (rank === 2) {
			// TODO: think about removing or repurposing global mods
			this.server.adminMessage(`DEV${this.uid} (${this.world.name}, ${this.ip.ip}) Got local mod`);
			this.sendMessage({
				sender: 'server',
				type: 'info',
				data:{
					message: "Server: You are now a moderator. Do /help for a list of commands."
				}
			})
		} else if (rank === 3) {
			this.server.adminMessage(`DEV${this.uid} (${this.world.name}, ${this.ip.ip}) Got admin`);
			this.sendMessage({
				sender: 'server',
				type: 'info',
				data:{
					message: "Server: You are now an admin. Do /help for a list of commands."
				}
			})
		}
	}

	startProtocol() {
		if (this.ip.banExpiration !== 0) {
			if (this.ip.banExpiration === -1) {
				this.sendMessage({
					sender: 'server',
					type: 'error',
					data:{
						message: `You are banned. ${this.server.config.appealMessage}`
					}
				})
				this.destroy()
				return
			}
			if (this.ip.banExpiration > Date.now()) {
				this.sendMessage({
					sender: 'server',
					type: 'error',
					data:{
						message: `Remaining time: ${formatDuration(this.ip.banExpiration - Date.now())}`
					}
				})
				this.sendMessage({
					sender: 'server',
					type: 'error',
					data:{
						message: `You are banned. ${this.server.config.appealMessage}`
					}
				})
				this.destroy()
				return
			}
			this.ip.setProp("banExpiration", 0)
		}

		// Check for admin password in cookies
		if (this.ws.extra.adminpass && process.env.ADMINPASS) {
			if (this.ws.extra.adminpass === process.env.ADMINPASS) {
				this.setRank(3);
			} else {
				// this.sendMessage({
				// 	sender: 'server',
				// 	data: {
				// 		action: 'invalidatePassword',
				// 		passwordType: 'adminlogin'
				// 	}
				// });
			}
		}

		let isWhitelisted = this.ip.isWhitelisted()
		if (this.server.lockdown && !isWhitelisted && this.getRank() < 3) {
			this.sendMessage({
				sender: 'server',
				type: 'error',
				data:{
					message: "Sorry, the server is not accepting new connections right now."
				}
			})
			this.destroy()
			return
		}
		if (this.ip.tooManyClients()) {
			this.sendMessage({
				sender: 'server',
				type: 'error',
				data:{
					message: `Sorry, but you have reached the maximum number of simultaneous connections, (${this.server.config.maxConnectionsPerIp}).`
				}
			})
			this.destroy()
			return
		}
		let requiresVerification
		switch (this.server.config.captchaSecurity) {
			case 0: {
				requiresVerification = false
				break
			}
			case 1: {
				requiresVerification = !isWhitelisted
				break
			}
			case 2: {
				requiresVerification = true
			}
		}
		if (requiresVerification && this.getRank() < 3) {
			this.setCaptchaState(0x00)
		} else {
			this.setCaptchaState(0x03)
		}
	}

	setCaptchaState(value) {
		this.captchaState = value
		let buffer = Buffer.allocUnsafeSlow(2)
		buffer[0] = 0x05
		buffer[1] = value
		this.sendBuffer(buffer)
	}

	handleMessage(message, isBinary) {
		if (!this.world) {
			this.handlePreWorld(message, isBinary)
			return
		}
		if (!isBinary) {
			this.handleString(message, isBinary)
			return
		}
		message = Buffer.from(message)
		switch (message.length) {
			//request chunk
			case 8: {
				let chunkX = message.readInt32LE(0)
				if (chunkX > maxChunkCoord || chunkX < minChunkCoord) {
					this.destroy()
					return
				}
				let chunkY = message.readInt32LE(4)
				if (chunkY > maxChunkCoord || chunkY < minChunkCoord) {
					this.destroy()
					return
				}
				let regionId = ((chunkX >> 4) + 0x10000) + (((chunkY >> 4) + 0x10000) * 0x20000)
				let region = this.world.getRegion(regionId)
				if (!region.loaded) {
					let deferredActions = this.handleUnloaded(region)
					if (!deferredActions) return
					let buffer = Buffer.allocUnsafe(1)
					buffer[0] = (chunkY & 0xf) << 4 | chunkX & 0xf
					deferredActions.push(buffer)
					if (++this.deferredAmount >= 100000 && this.rank < 3) {
						this.destroy()
					}
					return
				}
				region.requestChunk(this, (chunkY & 0xf) << 4 | chunkX & 0xf)
				return
			}
			//request region (aka. load chunk 2)
			// not really tested or implemented in client, disable for now
			// case 9: {
			// 	let regionX = message.readInt32LE(0)
			// 	if (regionX > maxRegionCoord || regionX < minRegionCoord) {
			// 		this.destroy()
			// 		return
			// 	}
			// 	let regionY = message.readInt32LE(4)
			// 	if (regionY > maxRegionCoord || regionY < minRegionCoord) {
			// 		this.destroy()
			// 		return
			// 	}
			// 	if (message[8] !== 1) {
			// 		this.destroy()
			// 		return
			// 	}
			// 	let regionId = (regionX + 0x10000) + ((regionY + 0x10000) * 0x20000)
			// 	let region = this.world.getRegion(regionId)
			// 	region.requestRegion(this)
			// 	return
			// }
			//set pixel
			case 11: {
				if (this.rank < 1) return
				let x = message.readInt32LE(0)
				if (x > maxPixelCoord || x < minPixelCoord) {
					this.destroy()
					return
				}
				let y = message.readInt32LE(4)
				if (y > maxPixelCoord || y < minPixelCoord) {
					this.destroy()
					return
				}
				if (this.rank < 3) {
					if (!this.pquota.canSpend()) return
					let xDistance = (x >> 4) - (this.x >> 8)
					let yDistance = (y >> 4) - (this.y >> 8)
					let distance = Math.sqrt(Math.pow(xDistance, 2) + Math.pow(yDistance, 2))
					if (distance > 4) return
				}
				let regionId = ((x >> 8) + 0x10000) + (((y >> 8) + 0x10000) * 0x20000)
				let region = this.world.getRegion(regionId)
				if (!region.loaded) {
					let deferredActions = this.handleUnloaded(region)
					if (!deferredActions) return
					let buffer = Buffer.allocUnsafe(5)
					buffer[0] = x & 0xff
					buffer[1] = y & 0xff
					buffer[2] = message[8]
					buffer[3] = message[9]
					buffer[4] = message[10]
					deferredActions.push(buffer)
					if (++this.deferredAmount >= 100000 && this.rank < 3) {
						this.destroy()
					}
					return
				}
				region.setPixel(this, x & 0xff, y & 0xff, message[8], message[9], message[10])
				return
			}
			//chunk paste
			case 776: {
				if (this.rank < 2) return
				if (this.rank < 3) {
					if (!this.world.pastingAllowed.value) {
						if (!this.noPasteTold) {
							this.noPasteTold = true
							this.sendMessage({
								sender: 'server',
								type: 'error',
								data:{
									message: "Pasting is disabled in this world, sorry!"
								}
							})
						}
						return
					}
					if (!this.pquota.canSpend()) return
				}
				let chunkX = message.readInt32LE(0)
				if (chunkX > maxChunkCoord || chunkX < minChunkCoord) {
					this.destroy()
					return
				}
				let chunkY = message.readInt32LE(4)
				if (chunkY > maxChunkCoord || chunkY < minChunkCoord) {
					this.destroy()
					return
				}
				let regionId = ((chunkX >> 4) + 0x10000) + (((chunkY >> 4) + 0x10000) * 0x20000)
				let region = this.world.getRegion(regionId)
				if (!region.loaded) {
					let deferredActions = this.handleUnloaded(region)
					if (!deferredActions) return
					let buffer = Buffer.allocUnsafe(769)
					buffer[0] = (chunkY & 0xf) << 4 | chunkX & 0xf
					message.copy(buffer, 1, 8)
					deferredActions.push(buffer)
					if (++this.deferredAmount >= 100000 && this.rank < 3) {
						this.destroy()
					}
					return
				}
				region.pasteChunk((chunkY & 0xf) << 4 | chunkX & 0xf, message.subarray(8))
				return
			}
			//erase chunk
			case 13: {
				if (this.rank < 2) return
				if (this.rank < 3) {
					if (this.world.simpleMods.value) return
					if (!this.pquota.canSpend()) return
				}
				let chunkX = message.readInt32LE(0)
				if (chunkX > maxChunkCoord || chunkX < minChunkCoord) {
					this.destroy()
					return
				}
				let chunkY = message.readInt32LE(4)
				if (chunkY > maxChunkCoord || chunkY < minChunkCoord) {
					this.destroy()
					return
				}
				let regionId = ((chunkX >> 4) + 0x10000) + (((chunkY >> 4) + 0x10000) * 0x20000)
				let region = this.world.getRegion(regionId)
				if (!region.loaded) {
					let deferredActions = this.handleUnloaded(region)
					if (!deferredActions) return
					let buffer = Buffer.allocUnsafe(4)
					buffer[0] = (chunkY & 0xf) << 4 | chunkX & 0xf
					buffer[1] = message[8]
					buffer[2] = message[9]
					buffer[3] = message[10]
					deferredActions.push(buffer)
					if (++this.deferredAmount >= 100000 && this.rank < 3) {
						this.destroy()
					}
					return
				}
				region.eraseChunk((chunkY & 0xf) << 4 | chunkX & 0xf, message[8], message[9], message[10])
				return
			}
			//protect chunk
			case 10: {
				if (this.rank < 2) return
				if (this.rank < 3) {
					if (this.world.simpleMods.value) return
					if (!this.protectquota.canSpend()) return
				}
				let chunkX = message.readInt32LE(0)
				if (chunkX > maxChunkCoord || chunkX < minChunkCoord) {
					this.destroy()
					return
				}
				let chunkY = message.readInt32LE(4)
				if (chunkY > maxChunkCoord || chunkY < minChunkCoord) {
					this.destroy()
					return
				}
				if (message[8] > 1) {
					this.destroy()
					return
				}
				let regionId = ((chunkX >> 4) + 0x10000) + (((chunkY >> 4) + 0x10000) * 0x20000)
				let region = this.world.getRegion(regionId)
				if (!region.loaded) {
					let deferredActions = this.handleUnloaded(region)
					if (!deferredActions) return
					let buffer = Buffer.allocUnsafe(2)
					buffer[0] = (chunkY & 0xf) << 4 | chunkX & 0xf
					buffer[1] = message[8]
					deferredActions.push(buffer)
					if (++this.deferredAmount >= 100000 && this.rank < 3) {
						this.destroy()
					}
					return
				}
				region.protectChunk((chunkY & 0xf) << 4 | chunkX & 0xf, message[8])
				return
			}
			//player update
			case 12: {
				this.updated = true
				let x = message.readInt32LE(0)
				let y = message.readInt32LE(4)
				this.r = message[8]
				this.g = message[9]
				this.b = message[10]
				let tool = message[11]
				if (this.rank < 2) {
					if (tool === 3 || tool === 6 || tool === 9 || tool === 10) tool = 0
					if (this.rank < 1) {
						if (tool === 0 || tool === 2 || tool === 5 || tool === 8) tool = 1
					}
				}
				this.tool = tool
				if (this.rank < 2) {
					let maxTpDistance = this.world.maxTpDistance.value
					if (Math.abs(x >> 4) > maxTpDistance.value || Math.abs(y >> 4) > maxTpDistance.value) {
						let distance = Math.sqrt(Math.pow((x >> 4) - (this.sentX >> 4), 2) + Math.pow((y >> 4) - (this.sentY >> 4), 2))
						if (distance > 10000) {
							this.teleport(this.sentX, this.sentY)
							return
						}
					}
				}
				this.x = x
				this.y = y
				return
			}
			//rank verification
			case 1: {
				if (message[0] > this.rank) {
					this.destroy()
					return
				}
				return
			}
			default: {
				this.destroy()
			}
		}
	}

	handleUnloaded(region) {
		if (!region.beganLoading) {
			if (this.rank < 3 && !this.regionloadquota.canSpend()) {
				this.server.adminMessage(`DEVKicked ${this.uid} (${this.world.name}, ${this.ip.ip}) for loading too many regions`)
				this.destroy()
				return false
			}
			region.load()
		}
		let regionId = region.id
		let deferredActions = this.deferredRegionActions.get(regionId)
		if (!deferredActions) {
			deferredActions = []
			this.deferredRegionActions.set(regionId, deferredActions)
			this.awaitRegionLoad(regionId)
		}
		return deferredActions
	}

	async awaitRegionLoad(regionId) {
		let region = this.world.getRegion(regionId)
		await region.loadPromise
		if (this.destroyed) return
		let deferredActions = this.deferredRegionActions.get(regionId)
		this.deferredAmount -= deferredActions.length
		this.deferredRegionActions.delete(regionId)
		for (let action of deferredActions) {
			switch (action.length) {
				//request chunk
				case 1: {
					region.requestChunk(this, action[0])
					continue
				}
				//set pixel
				case 5: {
					region.setPixel(this, action[0], action[1], action[2], action[3], action[4])
					continue
				}
				//chunk paste
				case 769: {
					region.pasteChunk(action[0], action.subarray(1))
					continue
				}
				//erase chunk
				case 4: {
					region.eraseChunk(action[0], action[1], action[2], action[3])
					continue
				}
				//protect chunk
				case 2: {
					region.protectChunk(action[0], action[1])
				}
			}
		}
	}

	async handlePreWorld(message, isBinary) {
		let expecting = [2, 0, 0, 1, 0][this.captchaState]
		if (this.joiningWorld) expecting = 0

		if (expecting === 0) {
			//not expecting a message, destroy for protocol violation
			this.destroy()
			return
		}
		if (expecting === 1) {
			//expecting world join
			if (!isBinary) {
				this.destroy()
				return
			}
			message = Buffer.from(message)
			//check if too long
			if (message.length > 26 || message.length <= 2) {
				this.destroy()
				return
			}
			//check worldVerification (minecraft port owo)
			if (message.readUint16LE(message.length - 2) !== 25565) {
				this.destroy()
				return
			}
			//validate world name
			let worldName = message.toString("utf8", 0, message.length - 2);
			if (!this.server.worlds.validateWorldName(worldName)) {
				this.destroy();
				return;
			}
			this.joiningWorld = true

			let world = await this.server.worlds.fetch(worldName)
			if (this.destroyed) return
			try {
				// where's raii when you need it
				world.ref()

				// check if moderator rank should be autogranted
				if (this.getRank() < 2 && (world.modpass.value || world.pass.value) && this.ws.extra && this.ws.extra.worldpass) {
					if (this.ws.extra.worldpass === world.modpass.value) {
						this.setRank(2);
					} else if (this.ws.extra.worldpass === world.pass.value) {
						this.setRank(1);
					} else {
						// this.sendMessage({
						// 	sender: 'server',
						// 	data:{
						// 		action: 'invalidatePassword',
						// 		passwordType: 'worldpass'
						// 	}
						// });
					}
				}

				if (world.isFull(this.getRank())) {
					this.sendMessage({
						sender: 'server',
						type: 'error',
						data:{
							message: "World full, try again later!"
						}
					})
					this.destroy()
					return
				}

				// check if the client is banned in that world
				// moderators and admins can join even if banned
				const banInfo = this.getRank() < 2 ? await world.isBanned(this) : null;
				if (this.destroyed) return
				if (banInfo) {
					const isPermanentBan = banInfo.timestamp === -1;
					let message = `Your ${banInfo.kind} (Ban ID: ${banInfo.value}) is banned from this world.`;

					if (!isPermanentBan) {
						const remainingTimeMs = Math.max(0, banInfo.timestamp - Date.now());
						const durationString = formatDuration(remainingTimeMs);
						message += ` You will be unbanned in ${durationString}.`;
					}

					if (banInfo.comment) {
						message += ` Reason: ${banInfo.comment}`;
					}

					this.sendMessage({
						sender: 'server',
						type: 'error',
						data:{
							message: message,
							banInfo: {
								kind: banInfo.kind,
								value: banInfo.value,
								timestamp: banInfo.timestamp,
								comment: banInfo.comment,
								isPermanent: isPermanentBan
							}
						}
					})
					this.destroy()
					return
				}

				world.addClient(this)
				this.joiningWorld = false
			} finally {
				world.unref()
			}
			return
		}
		//expecting captcha
		if (isBinary) {
			this.destroy()
			return
		}
		message = textDecoder.decode(message)
		if (!message.startsWith("CaptchA")) {
			this.destroy()
			return
		}
		let slice = message.substring(7)
		if (slice.startsWith("LETMEINPLZ")) {
			slice = slice.substring(10)
			if (slice !== process.env.CAPTCHAPASS) {
				this.destroy()
				return
			}
			this.setCaptchaState(0x03)
			return
		}
		if (!this.ip.captchaquota.canSpend()) {
			this.sendMessage({
				sender: 'server',
				type: 'error',
				data:{
					message: "You've done too many captchas recently. Try again in a few seconds."
				}
			})
			this.destroy()
			return
		}
		this.setCaptchaState(0x01)
		let isValid = await verifyCaptchaToken(slice)
		if (this.destroyed) return
		if (!isValid) {
			this.setCaptchaState(0x04)
			this.destroy()
			return
		}
		this.ip.setProp("whitelist", this.server.whitelistId)
		this.setCaptchaState(0x03)
	}

	handleString(message) {
		if (this.rank < 3 && !this.cquota.canSpend()) return
		message = textDecoder.decode(message)
		if (!message.endsWith("\n")) {
			this.destroy()
			return
		}
		message = message.substring(0, message.length - 1)
		if (message.length > maxMessageLengths[this.rank]) return
		if (message.startsWith("/")) {
			message = message.trim()
			handleCommand(this, message)
		} else {
			if (this.rank < 3 && this.mute) return
			message = message.trim()
			if (message.length === 0) return
			this.world.sendChat(this, message)
		}
	}

	teleport(x, y) {
		this.updated = true
		this.x = x
		this.y = y
		let buffer = Buffer.allocUnsafeSlow(9)
		buffer[0] = 0x03
		buffer.writeInt32LE(x >> 4, 1)
		buffer.writeInt32LE(y >> 4, 5)
		this.sendBuffer(buffer)
	}

	setPbucketMult(mult) {
		this.pmult = mult;
		// send the quota buffer with updated multiplier
		this.setPquota(this.prate, this.pper);
	}

	tick(tick) {
		if (!this.updated) return
		this.updated = false
		this.lastUpdate = tick
		this.sentX = this.x
		this.sentY = this.y
		if (!this.stealth) this.world.playerUpdates.add(this)
	}
}

