"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const block_1 = require("./block");
const { objectManager } = require("./object");
const { workerData, parentPort } = require("worker_threads");
let nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
let time = Math.floor(new Date().getTime() / 1000);
try {
    let block = new block_1.Block(workerData.previd, workerData.txids, '0', '00000000abc00000000000000000000000000000000000000000000000000000', time, "mel", "lonely", ["msorichi", "cullenoc"]);
    let networkBlock = block.toNetworkObject();
    while (true) {
        networkBlock.nonce = nonce.toString(16).padStart(64, '0');
        block.blockid = objectManager.id(networkBlock);
        if (block.hasPoW()) {
            parentPort.postMessage(networkBlock);
            process.exit();
        }
        ++nonce;
    }
}
catch (e) {
    console.log(e);
}
