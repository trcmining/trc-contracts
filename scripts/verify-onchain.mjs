/**
 * Does the source in this repository actually produce the bytecode that is live
 * on Ethereum mainnet?
 *
 * Read-only. Compiles locally, reads the deployed code back from a public node,
 * and compares. Nothing here signs or sends anything.
 *
 * Run with:  npx hardhat compile && node scripts/verify-onchain.mjs
 * Override the endpoint with MAINNET_RPC_URL if you would rather use your own node.
 *
 * Two comparisons are made, and both must pass:
 *
 *   1. The full runtime bytecode, with immutable slots masked out. Immutables are
 *      written into the code at construction time (the token address a distributor
 *      is bound to, for instance), so those bytes legitimately differ from a fresh
 *      local compile. Their exact positions come from the compiler's own
 *      immutableReferences output, not from guesswork; every other byte must match
 *      exactly. Each masked slot is printed so you can see what was excluded.
 *
 *   2. The metadata hash that solc appends to the bytecode. It is a hash of the
 *      source files themselves, so it is what ties this repository's text — down to
 *      the comments — to the contract on chain. This is also why the comments in
 *      contracts/*.sol are left exactly as deployed: editing one changes this hash.
 */
import fs from 'node:fs'
import path from 'node:path'

const RPC = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com'
const root = path.resolve(import.meta.dirname, '..')
const registry = JSON.parse(fs.readFileSync(path.join(root, 'deployments.json'), 'utf8'))['ethereum-mainnet']

/** The four deployed contracts, read from deployments.json so this cannot drift from it. */
const TARGETS = Object.entries(registry.contracts).map(([name, c]) => {
  const [file, contractName] = c.source.split(':')
  return { name, address: c.address, file, contractName }
})

/** Newest build-info wins; hardhat writes one per compiler input. */
function loadBuildInfo() {
  const dir = path.join(root, 'artifacts', 'build-info')
  if (!fs.existsSync(dir)) throw new Error('No artifacts. Run `npx hardhat compile` first.')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
}

function findCompiled(builds, file, contractName) {
  for (const b of builds) {
    const c = b.output?.contracts?.[file]?.[contractName]
    if (c?.evm?.deployedBytecode?.object) return c.evm.deployedBytecode
  }
  return null
}

async function getCode(address) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${j.error.message} (${RPC})`)
  return j.result
}

/** Blank out the immutable slots in a hex string, using the compiler's own offsets. */
function mask(hexNo0x, immutableReferences) {
  const chars = hexNo0x.split('')
  const spans = []
  for (const refs of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      spans.push({ start, length })
      for (let i = start * 2; i < (start + length) * 2 && i < chars.length; i++) chars[i] = '0'
    }
  }
  return { masked: chars.join(''), spans }
}

/** solc appends CBOR metadata; the last two bytes give its length. */
function metadataHash(hexNo0x) {
  if (hexNo0x.length < 8) return null
  const len = parseInt(hexNo0x.slice(-4), 16)
  if (!len || len * 2 + 4 > hexNo0x.length) return null
  const cbor = hexNo0x.slice(hexNo0x.length - 4 - len * 2, hexNo0x.length - 4)
  const m = cbor.match(/1220([0-9a-f]{64})/) // ipfs digest
  return m ? m[1] : cbor
}

const builds = loadBuildInfo()
let failed = 0

console.log(`node: ${RPC}\n`)

for (const t of TARGETS) {
  const compiled = findCompiled(builds, t.file, t.contractName)
  if (!compiled) {
    console.log(`✗ ${t.name}: not found in build artifacts (${t.source})`)
    failed++
    continue
  }
  const onchainRaw = (await getCode(t.address)).replace(/^0x/, '').toLowerCase()
  const localRaw = compiled.object.replace(/^0x/, '').toLowerCase()

  if (onchainRaw === '') {
    console.log(`✗ ${t.name} ${t.address}: no code at this address`)
    failed++
    continue
  }

  const a = mask(onchainRaw, compiled.immutableReferences)
  const b = mask(localRaw, compiled.immutableReferences)
  const codeMatch = a.masked === b.masked
  const hOn = metadataHash(onchainRaw)
  const hLocal = metadataHash(localRaw)
  const metaMatch = hOn !== null && hOn === hLocal

  const ok = codeMatch && metaMatch
  if (!ok) failed++

  console.log(`${ok ? '✓' : '✗'} ${t.name}  ${t.address}`)
  console.log(`    runtime bytecode : ${codeMatch ? 'identical' : 'DIFFERS'} (${onchainRaw.length / 2} bytes)`)
  if (a.spans.length) {
    console.log(`    immutables masked: ${a.spans.map((s) => `@${s.start}+${s.length}`).join(', ')}`)
  }
  console.log(`    metadata hash    : ${metaMatch ? hOn : `on-chain ${hOn} vs local ${hLocal}`}`)
  console.log()
}

if (failed) {
  console.log(`${failed} contract(s) did NOT match. Do not trust this repository until that is explained.`)
  process.exit(1)
}
console.log(`All ${TARGETS.length} contracts match the source in this repository.`)
