import { Worker } from 'worker_threads'
import { Block } from './block'
import { Chain, chainManager } from './chain'
import { logger } from './logger'
import { AnnotatedError, TransactionObjectType } from './message'
import { db, ObjectId, objectManager } from './object'
import { Transaction, Output } from './transaction'
import { UTXOSet } from './utxo'
import { Peer } from './peer'
import { network } from './network'
import { exitCode } from 'process'

let miners: Worker[] | null[] = [null, null, null, null];

class MemPool {
  txs: Transaction[] = []
  state: UTXOSet | undefined

  async init() {
    await this.load()
    setInterval(this.mine.bind(this), 60 * 1000)
    logger.debug('Mempool initialized')
  }
  getTxIds(): ObjectId[] {
    const txids = this.txs.map(tx => tx.txid)

    logger.debug(`Mempool txids: ${txids}`)

    return txids
  }
  async mine() {
    try {
      let coinbase: Transaction = new Transaction(
        "",
        [],
        // our public key in constructor of coinbase transaction
        [new Output("f3ba5af0a24a606d93f9bfe4c855346415b84263457f518a6b24588bc0d52692", 50000000000000)],
        chainManager.longestChainHeight + 1
      )
      let coinbaseNetworkObj: TransactionObjectType = coinbase.toNetworkObject()
      coinbase.txid = objectManager.id(coinbaseNetworkObj)
      let nextBlockTxIds: string[] = this.getTxIds()
      nextBlockTxIds.unshift(coinbase.txid)
      console.log("chaintip: ", chainManager.longestChainTip?.blockid, "height: ", chainManager.longestChainHeight + 1)

      for (let i = 0; i < miners.length; ++i) {
        let miner = miners[i]
        if (miner !== null) {
          await miner.terminate()
        }
        miner = new Worker("./dist/miner.js", {
          workerData: { 
            previd: chainManager.longestChainTip?.blockid,
            txids: nextBlockTxIds,
          }
        })
        miner.on("message", async (data) => {
          let newBlockID = objectManager.id(data)
          console.log("Mined block: ", data, "BlockID: ", newBlockID, "Coinbase: ", coinbaseNetworkObj)
          network.peers.forEach(async peer => { await peer.sendObject(data)
                                                await peer.sendObject(coinbaseNetworkObj)
                                                await peer.sendChainTip(newBlockID)
                                              })
          await objectManager.put(coinbaseNetworkObj);
        })
        miner.on("error", (error) => {
          console.log("Miner error: ", error)
        })
        miners[i] = miner
      }
    } catch (e) {
      console.log("catching error in mine(): ", e)
    }
  }
  async fromTxIds(txids: ObjectId[]) {
    this.txs = []

    for (const txid of txids) {
      this.txs.push(Transaction.fromNetworkObject(await objectManager.get(txid)))
    }
  }
  async save() {
    if (this.state === undefined) {
      throw new AnnotatedError('INTERNAL_ERROR', 'Could not save undefined state of mempool to cache.')
    }
    await db.put('mempool:txids', this.getTxIds())
    await db.put('mempool:state', Array.from(this.state.outpoints))
  }
  async load() {
    try {
      const txids = await db.get('mempool:txids')
      logger.debug(`Retrieved cached mempool: ${txids}.`)
      this.fromTxIds(txids)
    }
    catch {
      // start with an empty mempool of no transactions
      this.txs = []
      this.state = new UTXOSet(new Set())
      await this.save()
    }
    try {
      logger.debug(`Loading mempool state from cache`)
      const outpoints = await db.get('mempool:state')
      logger.debug(`Outpoints loaded from cache: ${outpoints}`)
      this.state = new UTXOSet(new Set<string>(outpoints))
    }
    catch {
      // // start with an empty state
      this.txs = []
      this.state = new UTXOSet(new Set())
      await this.save()
    }
  }
  async onTransactionArrival(tx: Transaction): Promise<boolean> {
    try {
      if (tx.isCoinbase()) {
        throw new Error('coinbase cannot be added to mempool')
      }
      await this.state?.apply(tx)
    }
    catch (e: any) {
      // failed to apply transaction to mempool, ignore it
      logger.debug(`Failed to add transaction ${tx.txid} to mempool: ${e.message}.`)
      return false
    }
    logger.debug(`Added transaction ${tx.txid} to mempool`)
    this.txs.push(tx)
    await this.save()
    return true
  }
  async reorg(lca: Block, shortFork: Chain, longFork: Chain) {
    logger.info('Reorganizing mempool due to longer chain adoption.')

    const oldMempoolTxs: Transaction[] = this.txs
    let orphanedTxs: Transaction[] = []

    for (const block of shortFork.blocks) {
      orphanedTxs = orphanedTxs.concat(await block.getTxs())
    }
    logger.info(`Old mempool had ${oldMempoolTxs.length} transaction(s): ${oldMempoolTxs}`)
    logger.info(`${orphanedTxs.length} transaction(s) in ${shortFork.blocks.length} block(s) were orphaned: ${orphanedTxs}`)
    orphanedTxs = orphanedTxs.concat(oldMempoolTxs)

    this.txs = []

    const tip = longFork.blocks[longFork.blocks.length - 1]
    if (tip.stateAfter === undefined) {
      throw new Error(`Attempted a mempool reorg with tip ${tip.blockid} for which no state has been calculted.`)
    }
    this.state = tip.stateAfter

    let successes = 0
    for (const tx of orphanedTxs) {
      const success = await this.onTransactionArrival(tx)

      if (success) {
        ++successes
      }
    }

    await this.save()
    if (chainManager.longestChainHeight >= 1690) {
      this.mine()
    }
    logger.info(`Re-applied ${successes} transaction(s) to mempool.`)
    logger.info(`${successes - orphanedTxs.length} transactions were abandoned.`)
    logger.info(`Mempool reorg completed.`)
  }
}

export const mempool = new MemPool()