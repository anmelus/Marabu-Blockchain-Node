import { logger } from './logger'
import { network } from './network'
import { chainManager } from './chain'
import { mempool } from './mempool'
import { AnnotatedError } from './message'

const BIND_PORT = 18018
const BIND_IP = '0.0.0.0'

logger.info(`cullcull - A Marabu node`)
logger.info(`Cullen O'Connell <cullenoc@stanford.edu>`)

async function main() {
  await chainManager.init()
  await mempool.init()
  network.init(BIND_PORT, BIND_IP)
}

main()
