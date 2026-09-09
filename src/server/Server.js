import uWS from "uWebSockets.js"
import { ServerClientManager } from "../client/ServerClientManager.js"
import { ServerIpManager } from "../ip/ServerIpManager.js"
import { ServerWorldManager } from "../world/ServerWorldManager.js"
import { StatsTracker } from "../stats/StatsTracker.js"
import { ServerRegionManager } from "../region/ServerRegionManager.js"
import { data as miscData, saveAndClose } from "./miscData.js"
import { handleRequest as handleApiRequest } from "../api/api.js"
import { handleIapiRequest } from "../api/iapi.js"
import { getIpFromHeader, parseCookies } from "../util/util.js"
import { loadCommands } from "../commands/commandHandler.js"
import { chmod } from 'fs'
import crypto from 'crypto'
import { fromByteArray as a85EncodeBytes } from '../util/ascii85.js'

let textEncoder = new TextEncoder()
let textDecoder = new TextDecoder()

export class Server {
	constructor(config) {
		this.config = config

		loadCommands(this);

		this.clients = new ServerClientManager(this)
		this.ips = new ServerIpManager(this)
		this.worlds = new ServerWorldManager(this)
		this.regions = new ServerRegionManager(this)

		this.listenSockets = []
		this.wsServer = this.createServer()
		this.globalTopic = Uint8Array.from([0x00]).buffer
		this.globalV2Topic = Uint8Array.from([0x01]).buffer
		this.adminTopic = Uint8Array.from([0x02]).buffer

		this.currentTick = 0
		this.nextTickTime = performance.now() + 1000 / 15
		this.tickTimeout = this.setTickTimeout()

		this.stats = new StatsTracker(this)

		this.whitelistId = miscData.whitelistId
		this.lockdown = false

		// Donation-related properties
		// Load donation data from miscData if available, otherwise use defaults
		const donations = miscData.donations || {};
		this.donCurUntil = donations.donCurUntil || 0;
		this.donLastMultiplier = 1.0;
		this.donLastMemo = donations.donLastMemo || "";
		this.donAnnounce = donations.donAnnounce !== undefined ? !!donations.donAnnounce : true;
		this.donMemos = donations.donMemos !== undefined ? !!donations.donMemos : true;
		this.donationsProcessed = new Set();

		// Geolocation concealment salt
		this.concealmentSalt = miscData.concealmentSalt || this.generateSalt();

		this.destroyed = false
		this.initializedAt = Date.now();
	}

  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.adminMessage("DEVServer shutdown initiated")
    clearTimeout(this.tickTimeout)
    this.listenSockets.forEach(sock => uWS.us_listen_socket_close(sock))
    this.clients.destroy()
    await this.worlds.destroy()
    await this.regions.destroy()
    await this.ips.destroy()

    // Save donation data to miscData before shutting down
    miscData.donations = {
      donCurUntil: this.donCurUntil,
      donLastMemo: this.donLastMemo,
      donAnnounce: this.donAnnounce,
      donMemos: this.donMemos
    };

    // Save concealment salt
    miscData.concealmentSalt = this.concealmentSalt;

    await saveAndClose()
  }

	createServer() {
		let server
		if (process.env.HTTPS === "true") {
			let options = {}
			if (process.env.CERT_FILE_NAME) options.cert_file_name = process.env.CERT_FILE_NAME
			if (process.env.DH_PARAMS_FILE_NAME) options.dh_params_file_name = process.env.DH_PARAMS_FILE_NAME
			if (process.env.KEY_FILE_NAME) options.key_file_name = process.env.KEY_FILE_NAME
			if (process.env.PASSPHRASE) options.passphrase = process.env.PASSPHRASE
			server = uWS.SSLApp(options)
		} else {
			server = uWS.App()
		}
		server.ws("/*", {
			maxPayloadLength: 1 << 15,
			maxBackpressure: 2 << 21,
			idleTimeout: 60,
			sendPingsAutomatically: true,
			upgrade: async (res, req, context) => {
				try {
					//read headers
					let secWebSocketKey = req.getHeader("sec-websocket-key")
					let secWebSocketProtocol = req.getHeader("sec-websocket-protocol")
					let secWebSocketExtensions = req.getHeader("sec-websocket-extensions")
					let origin = req.getHeader("origin")
					//get chat format
					let format = req.getQuery("chat") == "v2" ? "v2" : "v1";
					let isBot = req.getHeader("bot-identifier")?.trim() !== "" || req.getHeader("isBot") === "true";
					let botIdentifier = req.getHeader("bot-identifier");
					let botSecret = req.getHeader('bot-secret');
					//read cookies
					let cookieHeader = req.getHeader("cookie");
					let cookies = parseCookies(cookieHeader);
					//read optional proxy headers (only if proxied)
					let geoData = this.isProxied() ? {
						continentCode: req.getHeader("x-continent-code"),
						countryCode: req.getHeader("x-country-code"),
						countryIsInEu: req.getHeader("x-country-is-in-eu"),
						countryName: req.getHeader("x-country-name"),
						cityName: req.getHeader("x-city-name"),
						asn: req.getHeader("x-asn"),
						asnName: req.getHeader("x-asn-name"),
					} : {};
					let adminPass = null;
					let worldPass = null;
					try {
						if (cookies.adminpass) adminPass = Buffer.from(cookies.adminpass, 'base64').toString();
						if (cookies.worldpass) worldPass = Buffer.from(cookies.worldpass, 'base64').toString();
					} catch (e) { }
					//handle abort
					let aborted = false
					res.onAborted(() => {
						aborted = true
					})
					//async get ip data
					let ip = this.getClientIp(res, req);
					ip = await this.ips.fetch(ip)
					if (aborted) return
					if (this.destroyed) {
						res.writeStatus("503 Service Unavailable")
						res.end()
					} else {
						res.cork(() => {
							res.upgrade({
								origin,
								ip,
								format,
								closed: false,
								extra: {
									isBot,
									botSecret,
									botIdentifier,
									geoData,
									worldpass: worldPass || null,
									adminpass: adminPass || null
								},
							}, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context)
						})
					}
				} catch (error) {
					console.error(error)
				}
			},
			open: ws => {
				// ws.subscribe(this.globalTopic)
				if(ws.format==="v2") ws.subscribe(this.globalV2Topic);
				else ws.subscribe(this.globalTopic);
				try {
					this.stats.totalConnections++
					let client = this.clients.createClient(ws)
					ws.client = client
					if(ws.extra.isBot) client.bot = true;
					client.startProtocol()
				} catch (error) {
					console.error(error)
				}
			},
			message: (ws, message, isBinary) => {
				try {
					ws.client.handleMessage(message, isBinary)
				} catch (error) {
					console.error(error)
				}
			},
			close: (ws, code, message) => {
				try {
					ws.closed = true
					ws.client.destroy()
				} catch (error) {
					console.error(error)
				}
			}
		})
		this.createApiHandlers(server)
		server.any("/*", (res, req) => {
			res.writeStatus("400 Bad Request")
			res.end()
		})
    if (process.env.UNIX_SOCKET) {
      server.listen_unix(listenSocket => {
        if (!listenSocket) {
          console.error("Failed to listen on:", process.env.UNIX_SOCKET)
          return
        }
        this.listenSockets.push(listenSocket)
        if (process.env.UNIX_MODE) chmod(process.env.UNIX_SOCKET, process.env.UNIX_MODE, err => {
          if (err) console.error("Failed to chmod the unix socket", err)
        })
      }, process.env.UNIX_SOCKET)
    }
    if (process.env.WS_PORT) {
  		server.listen(parseInt(process.env.WS_PORT), listenSocket => {
        if (!listenSocket) {
          console.error("Failed to listen on port:", process.env.WS_PORT)
          return
        }
  			this.listenSockets.push(listenSocket)
      })
		}
		return server
	}

	setTickTimeout() {
		let timeUntilTick = this.nextTickTime - performance.now()
		if (timeUntilTick < -5000) {
			console.warn(`Ticking behind by ${Math.round(-timeUntilTick)}ms`)
		}
		this.tickTimeout = setTimeout(this.tick.bind(this), timeUntilTick)
	}

	tick() {
		let tick = ++this.currentTick
		this.nextTickTime = this.nextTickTime + 1000 / 15
		this.setTickTimeout()

		//every second
		if ((tick % 15) === 0) {
			this.clients.tickExpiration(tick)
			this.worlds.tickExpiration(tick)
			this.ips.tickExpiration(tick)
			// Handle donation multiplier updates
			let curMult = this.getDonationMultiplier();
			if (curMult !== this.donLastMultiplier) {
				this.worlds.updatePrate(this.donLastMultiplier, curMult);
				this.donLastMultiplier = curMult;
			}
		}
		//every hour
		if ((tick % 54000) === 0) {
			this.stats.tickPixels()
		}
		this.clients.tick(tick)
		this.worlds.tick(tick)
	}

	adminMessage(message) {
		let arrayBuffer = textEncoder.encode(message).buffer
		this.wsServer.publish(this.adminTopic, arrayBuffer, false)
	}

	broadcastBuffer(buffer) {
		let arrayBuffer = buffer.buffer
		this.wsServer.publish(this.globalTopic, arrayBuffer, true)
		this.wsServer.publish(this.globalV2Topic, arrayBuffer, true)
	}

	broadcastString(string) {
		let arrayBuffer = textEncoder.encode(string).buffer
		this.wsServer.publish(this.globalTopic, arrayBuffer, false)
	}

	broadcastJSON(message){
		this.wsServer.publish(this.globalV2Topic, JSON.stringify(message), false);
	}

	getDonationUntil() {
		const now = Date.now();
		return now > this.donCurUntil ? 0 : this.donCurUntil;
	}

	setDonationUntil(val) {
		this.donCurUntil = val;
	}

	getDonationMultiplier() {
		let unt = this.getDonationUntil();
		let now = Date.now();
		if (unt < now) return 1.0;
		// 2x base for any donation + 0.1x every 2 hours, capped at 5x
		let rate = 2.0 + Math.floor((unt - now) / 1000 / 60 / 120) * 0.1;
		return rate > 5.0 ? 5.0 : rate;
	}

	isProxied() {
		return process.env.IS_PROXIED === "true";
	}

	isAuthorizedReverseProxy(ip) {
		let authProxies = process.env.AUTHORIZED_REVERSE_PROXIES;
		if (typeof authProxies == "string") {
			authProxies = authProxies.split(",").map(x => x.trim());
			return authProxies.includes(ip);
		}
		return false;
	}

	getPreviousIpInProxyChain(proxies, currentIp) {
		if (typeof proxies != "string") return currentIp;
		if (currentIp.match(/[^\d\.]/g)) return currentIp;
		const prevRegex = new RegExp(`\\b(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}),\\s*${currentIp.replace(/\./g, "\\.")}$`)
		let prevMatch = prevRegex.exec(proxies);
		if (!prevMatch) return currentIp;
		return prevMatch[1];
	}

	getRawSocketIp(res, req) {
		// Try to get IP from proxy headers first if proxied
		if (this.isProxied()) {
			return getIpFromHeader(req.getHeader(process.env.REAL_IP_HEADER));
		}
		// Fallback to direct IP
		return textDecoder.decode(res.getRemoteAddressAsText());
	}

	getClientIp(res, req) {
		let rawIp = this.getRawSocketIp(res, req);
		if (this.isProxied() && this.isAuthorizedReverseProxy(rawIp)) {
			return this.getPreviousIpInProxyChain(req.getHeader("x-forwarded-for"), rawIp);
		}
		return rawIp;
	}

	handleDonation(id, world, client, amount, memo) {
		// Check for duplicate donation IDs
		if (this.donationsProcessed.has(id)) {
			console.warn(`Duplicate donation ID detected: ${id}`);
			return;
		}

		this.donationsProcessed.add(id);

		let hour = 1000 * 60 * 60;
		let duration = hour * amount;
		let now = Date.now();

		let curUntil = this.getDonationUntil();

		let newUntil = 0;
		if (curUntil > now) {
			newUntil = curUntil + duration;
		} else {
			newUntil = now + duration;
		}

		this.setDonationUntil(newUntil);

		// Broadcast donation until to all clients
		let msg = Buffer.allocUnsafeSlow(9);
		msg[0] = 0x09; // DONATION_UNTIL
		msg.writeBigInt64LE(BigInt(newUntil), 1);
		this.broadcastBuffer(msg);

		let message = "[Server] ";
		if (client) {
			message += "User '" + client.getNick() + "', of world '" + world + "'";
		} else {
			message += "A User";
		}

		let trimmedString = amount.toFixed(2);
		message += " has just donated " + trimmedString + " EUR!";

		if (!this.donMemos) {
			memo = "";
		} else {
			// Memo processing
			memo = memo.trim();

			if (memo.length > 256) {
				memo = memo.substring(0, 256);
			}
		}

		if (memo.length > 0) {
			message += " Message: " + memo;
		}

		this.donLastMemo = memo;

		if (this.donAnnounce) {
			this.broadcastString(message); // v1 chat clients
			// v2 chat clients
			this.broadcastJSON({
				sender: 'server',
				type: 'info',
				data: {
					action: 'donationRecv',
					nick: client?.getNick(),
					world: world,
					qty: trimmedString,
					memo: memo,
					message: message
				}
			});
		} else {
			console.log(message);
		}
	}

	setDonAnnounce(state) {
		this.donAnnounce = state;
	}

	setDonMemos(state) {
		if (!state) {
			this.donLastMemo = "";
		}
		this.donMemos = state;
	}

	resetWhitelist() {
		this.whitelistId++
		miscData.whitelistId = this.whitelistId
	}

	kickNonAdmins() {
		let count = 0
		for (let client of this.clients.map.values()) {
			if (client.rank === 3) continue
			client.destroy()
			count++
		}
		return count
	}

	setLockdown(state) {
		this.lockdown = state
		this.adminMessage(`DEVLockdown mode ${state ? "enabled" : "disabled"}.`)
		if (!state) return
		for (let client of this.clients.map.values()) {
			if (client.rank < 3) continue
			if (client.ip.isWhitelisted()) continue
			client.ip.setProp("whitelist", this.whitelistId)
		}
	}

	checkLockdown() {
		for (let client of this.clients.map.values()) {
			if (client.rank < 3) continue
			if (client.ip.isWhitelisted()) continue
			return
		}
		//if we made it through the for loop, then there are no whitelisted admins
		this.setLockdown(false)
	}

	createApiHandlers(server) {
		server.any("/iapi", (res, req) => {
			handleIapiRequest(this, res, req)
		})

		server.any("/iapi/*", (res, req) => {
			handleIapiRequest(this, res, req)
		})

		server.any("/api", (res, req) => {
			handleApiRequest(this, res, req)
		})
		server.any("/api/*", (res, req) => {
			handleApiRequest(this, res, req)
		})
	}

	generateSalt() {
		return crypto.randomBytes(64).toString('hex');
	}

	conceal(input) {
		if (typeof input !== "string" || !input.length) {
			return "";
		}

		const hash = crypto.createHash('sha256');
		hash.update(input + this.concealmentSalt);
		const fullHashBuffer = hash.digest();

		const fullHashAscii85 = a85EncodeBytes(fullHashBuffer, false);

		const shortHashAscii85 = fullHashAscii85.substring(0, 12);

		return { short: shortHashAscii85, full: fullHashAscii85 };
	}
}

//simple way to watch the server's performance
/*
let userUsage = process.cpuUsage().user
let systemUsage = process.cpuUsage().system
setInterval(() => {
  let newUserUsage = process.cpuUsage().user
  let userDiff = newUserUsage - userUsage
  userUsage = newUserUsage
  let newSystemUsage = process.cpuUsage().system
  let systemDiff = newSystemUsage - systemUsage
  systemUsage = newSystemUsage
  console.log(userDiff / 1000000, systemDiff / 1000000)
}, 1000)
*/
