"use strict"

// Client networking for online multiplayer via PeerJS (WebRTC).
// Connects players directly peer-to-peer using room codes or quickmatch,
// with no dedicated game server required.
var Net = {
	PEER_PREFIX: "gwent-",
	ALPHABET: "23456789ABCDEFGHJKMNPQRSTUVWXYZ", // no 0/O/1/I/L
	CODE_LENGTH: 5,
	QM_SLOTS: ["gwent-qm-1", "gwent-qm-2", "gwent-qm-3", "gwent-qm-4", "gwent-qm-5"],

	peer: null,
	conn: null,
	connected: false,
	role: null, // "host" | "guest" | null
	code: null,
	pending: null, // { resolve, reject }

	onMessage: null, // cb(data) - game/lobby payloads from the peer
	onPeerJoined: null, // cb() - a guest joined our room
	onPeerLeft: null, // cb() - peer left, room destroyed, or connection lost
	onQmStatus: null, // cb(online) - player count display for quickmatch

	peerOptions() {
		const param = new URLSearchParams(window.location.search).get("peerServer") ||
		              new URLSearchParams(window.location.search).get("server");
		if (param && !param.startsWith("ws://localhost:8765")) {
			try {
				const url = new URL(param.startsWith("http") || param.startsWith("ws") ? param : "http://" + param);
				return {
					host: url.hostname,
					port: url.port ? parseInt(url.port, 10) : (url.protocol.startsWith("https") || url.protocol.startsWith("wss") ? 443 : 80),
					path: url.pathname && url.pathname !== "/" ? url.pathname : "/",
					secure: url.protocol.startsWith("https") || url.protocol.startsWith("wss"),
					debug: 0,
					logFunction: () => {}
				};
			} catch (_) {}
		}
		return { debug: 0, logFunction: () => {} };
	},

	makeCode() {
		let code = "";
		for (let i = 0; i < this.CODE_LENGTH; i++)
			code += this.ALPHABET[Math.floor(Math.random() * this.ALPHABET.length)];
		return code;
	},

	connect() {
		if (typeof Peer === "undefined") {
			return Promise.reject(new Error("unreachable"));
		}
		return Promise.resolve();
	},

	createRoom(retryCount = 0) {
		return new Promise((resolve, reject) => {
			this.cleanup();
			this.pending = { resolve, reject };

			const code = this.makeCode();
			const peerId = this.PEER_PREFIX + code.toLowerCase();

			let peer;
			try {
				peer = new Peer(peerId, this.peerOptions());
			} catch (e) {
				return this.settle(new Error("unreachable"));
			}

			this.peer = peer;

			peer.on("open", () => {
				this.code = code;
				this.role = "host";
				this.connected = true;
				this.settle(null, code);
			});

			peer.on("connection", conn => {
				if (this.conn && this.conn.open) {
					// Room already has an active guest
					conn.on("open", () => {
						try { conn.send({ type: "error", code: "full" }); } catch (_) {}
						setTimeout(() => { try { conn.close(); } catch (_) {} }, 100);
					});
					return;
				}
				this.setupConn(conn);
			});

			peer.on("error", err => {
				if (err.type === "unavailable-id" && retryCount < 5) {
					try { peer.destroy(); } catch (_) {}
					this.peer = null;
					this.createRoom(retryCount + 1).then(resolve, reject);
				} else {
					this.settle(new Error("unreachable"));
				}
			});
		});
	},

	joinRoom(code) {
		return new Promise((resolve, reject) => {
			this.cleanup();
			this.pending = { resolve, reject };

			const cleanCode = (code || "").trim().toUpperCase();
			if (!cleanCode)
				return this.settle(new Error("not-found"));

			const targetId = this.PEER_PREFIX + cleanCode.toLowerCase();

			let peer;
			try {
				peer = new Peer(this.peerOptions());
			} catch (e) {
				return this.settle(new Error("unreachable"));
			}

			this.peer = peer;

			peer.on("open", () => {
				this.code = cleanCode;
				this.role = "guest";
				const conn = peer.connect(targetId, { reliable: true });
				this.setupConn(conn);
			});

			peer.on("error", err => {
				if (err.type === "peer-unavailable") {
					this.settle(new Error("not-found"));
				} else {
					this.settle(new Error("unreachable"));
				}
			});
		});
	},

	quickMatch(slotIndex = 0) {
		if (slotIndex >= this.QM_SLOTS.length) {
			slotIndex = 0;
		}
		const slot = this.QM_SLOTS[slotIndex];

		return new Promise((resolve, reject) => {
			this.cleanup();
			this.pending = { resolve, reject };

			let probePeer;
			try {
				probePeer = new Peer(this.peerOptions());
			} catch (e) {
				return this.settle(new Error("unreachable"));
			}

			this.peer = probePeer;
			let settled = false;
			let timeout = null;

			const becomeHost = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				try { probePeer.destroy(); } catch (_) {}

				let hostPeer;
				try {
					hostPeer = new Peer(slot, this.peerOptions());
				} catch (e) {
					return this.settle(new Error("unreachable"));
				}

				this.peer = hostPeer;

				hostPeer.on("open", () => {
					this.code = slot;
					this.role = "host";
					this.connected = true;
					if (this.onQmStatus) this.onQmStatus(1);
					this.settle(null, slot);
				});

				hostPeer.on("connection", conn => {
					if (this.conn && this.conn.open) {
						conn.on("open", () => {
							try { conn.send({ type: "qm-reject", code: "full" }); } catch (_) {}
							setTimeout(() => { try { conn.close(); } catch (_) {} }, 100);
						});
						return;
					}

					let accepted = false;
					conn.on("data", data => {
						if (data && data.type === "qm-join" && !accepted) {
							if (this.conn && this.conn.open) {
								try { conn.send({ type: "qm-reject", code: "full" }); } catch (_) {}
								setTimeout(() => { try { conn.close(); } catch (_) {} }, 100);
								return;
							}
							accepted = true;
							try { conn.send({ type: "qm-accept" }); } catch (_) {}
							this.setupConn(conn);
							if (this.onPeerJoined)
								this.onPeerJoined();
						}
					});
				});

				hostPeer.on("error", err => {
					if (err.type === "unavailable-id") {
						this.quickMatch(slotIndex + 1).then(resolve, reject);
					} else {
						this.settle(new Error("unreachable"));
					}
				});
			};

			probePeer.on("open", () => {
				const conn = probePeer.connect(slot, { reliable: true });

				timeout = setTimeout(() => {
					if (!settled) becomeHost();
				}, 1200);

				conn.on("open", () => {
					try { conn.send({ type: "qm-join" }); } catch (_) {}
				});

				conn.on("data", msg => {
					if (!settled && msg && msg.type === "qm-accept") {
						settled = true;
						clearTimeout(timeout);
						this.code = slot;
						this.role = "guest";
						this.connected = true;
						this.setupConn(conn);
						if (this.onQmStatus) this.onQmStatus(2);
						this.settle(null, slot);
					} else if (!settled && msg && msg.type === "qm-reject") {
						settled = true;
						clearTimeout(timeout);
						try { probePeer.destroy(); } catch (_) {}
						this.quickMatch(slotIndex + 1).then(resolve, reject);
					}
				});

				conn.on("close", () => {
					if (!settled) becomeHost();
				});
			});

			probePeer.on("error", err => {
				if (err.type === "peer-unavailable") {
					becomeHost();
				} else if (!settled) {
					this.settle(new Error("unreachable"));
				}
			});
		});
	},

	setupConn(conn) {
		this.conn = conn;

		const onDisconnect = () => {
			this.handleClose();
		};

		if (conn.peerConnection) {
			conn.peerConnection.addEventListener("iceconnectionstatechange", () => {
				const state = conn.peerConnection.iceConnectionState;
				if (state === "disconnected" || state === "failed" || state === "closed")
					onDisconnect();
			});
			conn.peerConnection.addEventListener("connectionstatechange", () => {
				const state = conn.peerConnection.connectionState;
				if (state === "disconnected" || state === "failed" || state === "closed")
					onDisconnect();
			});
		}

		conn.on("open", () => {
			this.connected = true;
			if (this.role === "host") {
				if (this.onPeerJoined)
					this.onPeerJoined();
			} else if (this.role === "guest") {
				this.settle(null, this.code);
			}
		});

		conn.on("data", data => {
			this.route(data);
		});

		conn.on("close", () => {
			this.handleClose();
		});

		conn.on("error", () => {
			this.handleClose();
		});
	},

	send(data) {
		if (this.conn && this.conn.open) {
			this.conn.send({ type: "msg", data: data });
		}
	},

	leave() {
		if (this.conn && this.conn.open) {
			try {
				this.conn.send({ type: "peer-left" });
			} catch (_) {}
		}
		this.cleanup();
	},

	route(msg) {
		if (!msg || typeof msg !== "object") return;
		switch (msg.type) {
			case "msg":
				if (this.onMessage)
					this.onMessage(msg.data);
				break;
			case "error":
				if (this.pending)
					this.settle(new Error(msg.code));
				break;
			case "peer-left":
				this.handleClose();
				break;
		}
	},

	settle(err, val) {
		const p = this.pending;
		if (!p) return;
		this.pending = null;
		if (err) p.reject(err);
		else p.resolve(val);
	},

	trackEvent(type) {
		// Peer-to-peer mode: no telemetry server needed
	},

	handleClose() {
		const wasInRoom = this.connected && (this.conn !== null || this.role !== null);
		this.cleanup();
		if (this.pending)
			this.settle(new Error("unreachable"));
		else if (wasInRoom && this.onPeerLeft)
			this.onPeerLeft();
	},

	cleanup() {
		if (this.conn) {
			try { this.conn.close(); } catch (_) {}
			this.conn = null;
		}
		if (this.peer) {
			try { this.peer.destroy(); } catch (_) {}
			this.peer = null;
		}
		this.connected = false;
		this.code = null;
		this.role = null;
	}
};

window.addEventListener("beforeunload", () => {
	if (Net.connected) Net.leave();
});
window.addEventListener("pagehide", () => {
	if (Net.connected) Net.leave();
});

