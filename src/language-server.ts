/// <reference path="../node_modules/vscode/thenable.d.ts" />

import {
	IConnection,
} from 'vscode-languageserver';

import * as net from 'net';
import * as cluster from 'cluster';

import { newConnection, registerLanguageHandler } from './connection';
import { registerMasterHandler } from './master-connection';
import { TypeScriptService } from './typescript-service';
import * as fs from './fs';
import * as util from './util';

const program = require('commander');

process.on('uncaughtException', (err: string) => {
	console.error(err);
});

const defaultLspPort = 2089;
const numCPUs = require('os').cpus().length;

program
	.version('0.0.1')
	.option('-s, --strict', 'Strict mode')
	.option('-p, --port [port]', 'LSP port (' + defaultLspPort + ')', parseInt)
	.option('-c, --cluster [num]', 'Number of concurrent cluster workers (defaults to number of CPUs, ' + numCPUs + ')', parseInt)
	.parse(process.argv);

util.setStrict(program.strict);
const lspPort = program.port || defaultLspPort;
const clusterSize = program.cluster || numCPUs;

const workersReady = new Map<string, Promise<void>>();

function randomNWorkers(n: number): string[] {
	const unselected = Array.from(workersReady.keys());
	let numUnselected = unselected.length;
	const selected: string[] = [];
	for (let i = 0; i < n; i++) {
		const s = Math.floor(Math.random() * numUnselected);
		selected.push(unselected[s]);
		const a = unselected[numUnselected - 1], b = unselected[s];
		unselected[numUnselected - 1] = b, unselected[s] = a;
		numUnselected--;
	}
	return selected;
}

async function main(): Promise<void> {
	if (cluster.isMaster) {
		console.error(`Master node process spawning ${clusterSize} workers`)
		for (let i = 0; i < clusterSize; ++i) {
			const worker = cluster.fork().on('disconnect', () => {
				console.error(`worker ${worker.process.pid} disconnect`)
			});

			workersReady.set(worker.id, new Promise<void>((resolve, reject) => {
				worker.on('listening', resolve);
			}));
		}

		cluster.on('exit', (worker, code, signal) => {
			const reason = code === null ? signal : code;
			console.error(`worker ${worker.process.pid} exit (${reason})`);
		});

		var server = net.createServer(async (socket) => {
			const connection = newConnection(socket, socket);

			// Create connections to two worker servers
			const workerIds = randomNWorkers(2);
			await Promise.all(workerIds.map((id) => workersReady.get(id)));

			const workerConns: IConnection[] = [];
			await Promise.all(workerIds.map((id) => new Promise<void>((resolve, reject) => {
				const clientSocket = net.createConnection({ port: lspPort + parseInt(id) }, resolve);
				workerConns.push(newConnection(clientSocket, clientSocket));
			})));
			for (const workerConn of workerConns) {
				workerConn.onRequest(fs.ReadDirRequest.type, async (params: string): Promise<fs.FileInfo[]> => {
					return connection.sendRequest(fs.ReadDirRequest.type, params);
				});
				workerConn.onRequest(fs.ReadFileRequest.type, async (params: string): Promise<string> => {
					return connection.sendRequest(fs.ReadFileRequest.type, params);
				});
				workerConn.listen();
			}

			registerMasterHandler(connection, workerConns[0], workerConns[1]);
			connection.listen();
		});
		console.error('Master listening for incoming LSP connections on', lspPort);
		server.listen(lspPort);

	} else {
		console.error('Listening for incoming LSP connections on', lspPort + cluster.worker.id);
		var server = net.createServer((socket) => {
			const connection = newConnection(socket, socket);
			registerLanguageHandler(connection, program.strict, new TypeScriptService());
			connection.listen();
			console.error("worker", cluster.worker.id, "created connection");
		});
		server.listen(lspPort + parseInt(cluster.worker.id));
	}
}

main();
