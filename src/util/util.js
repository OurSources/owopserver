export async function verifyCaptchaToken(token) {
	try {
		let result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			body: new URLSearchParams({ secret: process.env.CAPTCHA_SECRET, response: token })
		})
		result = await result.json()
		return result.success === true
	} catch (error) {
		return false
	}
}

export function validateQuotaString(string) {
	let split = string.split(",")
	if (split.length !== 2) return false
	if (!split[0].match(/^\d+$/)) return false
	if (!split[1].match(/^\d+$/)) return false
	if (parseInt(split[0]) > 65535) return false
	if (parseInt(split[1]) > 65535) return false
	return true
}

export function parseColor(string) {
	if (!string.match(/^#[A-Fa-f0-9]{6}$/)) return false
	return parseInt(string.substring(1), 16)
}

export function getIpFromHeader(string) {
	let ips = string.split(",")
	return ips[ips.length - 1]
}

export const RANK = {
	NONE: 0,
	USER: 1,
	MODERATOR: 2,
	ADMIN: 3,
}

export const DEFAULT_PROPS = {
	"restricted": false,
	"pass": null,
	"modpass": null,
	"pquota": null,
	"motd": null,
	"bgcolor": 0xffffff,
	"doubleModPquota": true,
	"pastingAllowed": true,
	"maxPlayers": 255,
	"maxTpDistance": 12000000,
	"modPrefix": "(M)",
	"simpleMods": false,
	"allowGlobalMods": true,
}

export function formatPropValue(prop, value) {
	if (prop === "bgcolor") {
		return `#${value.toString(16).padStart(6, "0")}`;
	}
	return value;
}

export function formatDuration(milliseconds) {
	if (milliseconds <= 0) {
		return "0 seconds";
	}

	let seconds = Math.ceil(milliseconds / 1000);
	let minutes = Math.floor(seconds / 60);
	let hours = Math.floor(seconds / 60 / 60);
	let days = Math.floor(seconds / 60 / 60 / 24);

	seconds %= 60;
	minutes %= 60;
	hours %= 24;

	const parts = [];
	const getS = num => num !== 1 ? 's' : '';

	if (days > 0) {
		parts.push(`${days} day${getS(days)}`);
	}

	if (hours > 0) {
		parts.push(`${hours} hour${getS(hours)}`);
	}

	if (minutes > 0) {
		parts.push(`${minutes} minute${getS(minutes)}`);
	}

	if (seconds > 0) {
		parts.push(`${seconds} second${getS(seconds)}`);
	}

	return parts.join(" ");
}

export function parseCookies(cookieHeader) {
	let cookies = {};
	if (cookieHeader) {
		cookieHeader.split(';').forEach(cookie => {
			let [name, value] = cookie.trim().split('=');
			cookies[name] = value;
		});
	}
	return cookies;
}

export function parseDuration(duration) {
	const regex = /^(\d+)([a-zA-Z]*)$/;
	const match = duration.match(regex);

	if (!match) {
		throw new Error(`Invalid duration format: ${duration}`);
	}

	const value = parseInt(match[1]);
	const unit = (match[2] || 'm').toLowerCase(); // default to minutes

	switch (unit) {
		case 'm':
		case 'min':
		case 'minute':
			return value;
		case 'h':
		case 'hr':
		case 'hour':
			return value * 60;
		case 'd':
		case 'day':
			return value * 24 * 60;
		case 'w':
		case 'week':
			return value * 7 * 24 * 60;
		case 'mo':
		case 'month':
			return value * 30 * 24 * 60;
		case 'y':
		case 'year':
			return value * 365 * 24 * 60;
		default:
			throw new Error(`Unsupported duration unit: ${unit}`);
	}
}
