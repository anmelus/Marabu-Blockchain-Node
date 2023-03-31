"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mempool = void 0;
const worker_threads_1 = require("worker_threads");
const chain_1 = require("./chain");
const logger_1 = require("./logger");
const message_1 = require("./message");
const object_1 = require("./object");
const transaction_1 = require("./transaction");
const utxo_1 = require("./utxo");
const network_1 = require("./network");
let miners = [null, null, null, null];
class MemPool {
    constructor() {
        this.txs = [];
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.load();
            setInterval(this.mine.bind(this), 60 * 1000);
            logger_1.logger.debug('Mempool initialized');
        });
    }
    getTxIds() {
        const txids = this.txs.map(tx => tx.txid);
        logger_1.logger.debug(`Mempool txids: ${txids}`);
        return txids;
    }
    mine() {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let coinbase = new transaction_1.Transaction("", [], 
                // our public key in constructor of coinbase transaction
                [new transaction_1.Output("f3ba5af0a24a606d93f9bfe4c855346415b84263457f518a6b24588bc0d52692", 50000000000000)], chain_1.chainManager.longestChainHeight + 1);
                let coinbaseNetworkObj = coinbase.toNetworkObject();
                coinbase.txid = object_1.objectManager.id(coinbaseNetworkObj);
                let nextBlockTxIds = this.getTxIds();
                nextBlockTxIds.unshift(coinbase.txid);
                console.log("chaintip: ", (_a = chain_1.chainManager.longestChainTip) === null || _a === void 0 ? void 0 : _a.blockid, "height: ", chain_1.chainManager.longestChainHeight + 1);
                for (let i = 0; i < miners.length; ++i) {
                    let miner = miners[i];
                    if (miner !== null) {
                        yield miner.terminate();
                    }
                    miner = new worker_threads_1.Worker("./dist/miner.js", {
                        workerData: {
                            previd: (_b = chain_1.chainManager.longestChainTip) === null || _b === void 0 ? void 0 : _b.blockid,
                            txids: nextBlockTxIds,
                        }
                    });
                    miner.on("message", (data) => __awaiter(this, void 0, void 0, function* () {
                        let newBlockID = object_1.objectManager.id(data);
                        console.log("Mined block: ", data, "BlockID: ", newBlockID, "Coinbase: ", coinbaseNetworkObj);
                        network_1.network.peers.forEach((peer) => __awaiter(this, void 0, void 0, function* () {
                            yield peer.sendObject(data);
                            yield peer.sendObject(coinbaseNetworkObj);
                            yield peer.sendChainTip(newBlockID);
                        }));
                        yield object_1.objectManager.put(coinbaseNetworkObj);
                    }));
                    miner.on("error", (error) => {
                        console.log("Miner error: ", error);
                    });
                    miners[i] = miner;
                }
            }
            catch (e) {
                console.log("catching error in mine(): ", e);
            }
        });
    }
    fromTxIds(txids) {
        return __awaiter(this, void 0, void 0, function* () {
            this.txs = [];
            for (const txid of txids) {
                this.txs.push(transaction_1.Transaction.fromNetworkObject(yield object_1.objectManager.get(txid)));
            }
        });
    }
    save() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state === undefined) {
                throw new message_1.AnnotatedError('INTERNAL_ERROR', 'Could not save undefined state of mempool to cache.');
            }
            yield object_1.db.put('mempool:txids', this.getTxIds());
            yield object_1.db.put('mempool:state', Array.from(this.state.outpoints));
        });
    }
    load() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const txids = yield object_1.db.get('mempool:txids');
                logger_1.logger.debug(`Retrieved cached mempool: ${txids}.`);
                this.fromTxIds(txids);
            }
            catch (_a) {
                // start with an empty mempool of no transactions
                this.txs = [];
                this.state = new utxo_1.UTXOSet(new Set());
                yield this.save();
            }
            try {
                logger_1.logger.debug(`Loading mempool state from cache`);
                const outpoints = yield object_1.db.get('mempool:state');
                logger_1.logger.debug(`Outpoints loaded from cache: ${outpoints}`);
                this.state = new utxo_1.UTXOSet(new Set(outpoints));
            }
            catch (_b) {
                // // start with an empty state
                this.txs = [];
                this.state = new utxo_1.UTXOSet(new Set());
                yield this.save();
            }
        });
    }
    onTransactionArrival(tx) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            try {
                if (tx.isCoinbase()) {
                    throw new Error('coinbase cannot be added to mempool');
                }
                yield ((_a = this.state) === null || _a === void 0 ? void 0 : _a.apply(tx));
            }
            catch (e) {
                // failed to apply transaction to mempool, ignore it
                logger_1.logger.debug(`Failed to add transaction ${tx.txid} to mempool: ${e.message}.`);
                return false;
            }
            logger_1.logger.debug(`Added transaction ${tx.txid} to mempool`);
            this.txs.push(tx);
            yield this.save();
            return true;
        });
    }
    reorg(lca, shortFork, longFork) {
        return __awaiter(this, void 0, void 0, function* () {
            logger_1.logger.info('Reorganizing mempool due to longer chain adoption.');
            const oldMempoolTxs = this.txs;
            let orphanedTxs = [];
            for (const block of shortFork.blocks) {
                orphanedTxs = orphanedTxs.concat(yield block.getTxs());
            }
            logger_1.logger.info(`Old mempool had ${oldMempoolTxs.length} transaction(s): ${oldMempoolTxs}`);
            logger_1.logger.info(`${orphanedTxs.length} transaction(s) in ${shortFork.blocks.length} block(s) were orphaned: ${orphanedTxs}`);
            orphanedTxs = orphanedTxs.concat(oldMempoolTxs);
            this.txs = [];
            const tip = longFork.blocks[longFork.blocks.length - 1];
            if (tip.stateAfter === undefined) {
                throw new Error(`Attempted a mempool reorg with tip ${tip.blockid} for which no state has been calculted.`);
            }
            this.state = tip.stateAfter;
            let successes = 0;
            for (const tx of orphanedTxs) {
                const success = yield this.onTransactionArrival(tx);
                if (success) {
                    ++successes;
                }
            }
            yield this.save();
            if (chain_1.chainManager.longestChainHeight >= 1690) {
                this.mine();
            }
            logger_1.logger.info(`Re-applied ${successes} transaction(s) to mempool.`);
            logger_1.logger.info(`${successes - orphanedTxs.length} transactions were abandoned.`);
            logger_1.logger.info(`Mempool reorg completed.`);
        });
    }
}
exports.mempool = new MemPool();
