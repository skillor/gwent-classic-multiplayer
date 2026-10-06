// Test runner: serves static files on port 8077 if not already running,
// then runs all E2E suites. Invoked via `npm test`.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTTP_PORT = 8077;

const SUITES = [
	'e2e-singleplayer.js', // vs-AI
	'e2e-multiplayer.js',  // full online match, checksums, disconnect
	'e2e-rematch.js',      // re-ready + mid-game exit
	'e2e-quickmatch.js',   // find-opponent pairing, search screen, cancel
];

function isPortOpen(port) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => { socket.destroy(); resolve(false); });
	});
}

function startStaticServer(port) {
	const mimeTypes = {
		'.html': 'text/html',
		'.js': 'text/javascript',
		'.css': 'text/css',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.svg': 'image/svg+xml',
		'.ico': 'image/x-icon',
		'.json': 'application/json'
	};

	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let file = path.join(ROOT, req.url.split('?')[0]);
			if (req.url === '/' || req.url.startsWith('/?')) file = path.join(ROOT, 'index.html');
			fs.readFile(file, (err, data) => {
				if (err) {
					res.writeHead(404);
					return res.end('Not found');
				}
				const ext = path.extname(file).toLowerCase();
				res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
				res.end(data);
			});
		});

		server.listen(port, () => resolve(server));
	});
}

function run(cmd, cmdArgs) {
	return new Promise((resolve) => {
		const child = spawn(cmd, cmdArgs, { stdio: 'inherit' });
		child.on('exit', (code) => resolve(code === null ? 1 : code));
		child.on('error', () => resolve(1));
	});
}

(async () => {
	let server = null;
	const httpUp = await isPortOpen(HTTP_PORT);
	if (!httpUp) {
		server = await startStaticServer(HTTP_PORT);
		console.log('Started local static server on port ' + HTTP_PORT);
	}

	let failed = false;
	for (const suite of SUITES) {
		console.log('\n=== ' + suite + ' ===');
		const code = await run('node', [path.join(__dirname, suite)]);
		if (code !== 0) failed = true;
	}

	if (server) {
		server.close();
	}

	console.log('\n' + (failed ? 'SUITES FAILED' : 'ALL SUITES PASSED'));
	process.exit(failed ? 1 : 0);
})();
