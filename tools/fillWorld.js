// Fills a world with random pixel data, writing regions straight into the LevelDB
// store the server uses. Intended for generating a large test world to benchmark
// chunk loading against.
//
// The server MUST be stopped while this runs - LevelDB holds an exclusive lock.
//
// Usage:
//   node tools/fillWorld.js [--world main] [--radius 5000] [--mode noise|blocks] [--seed 1]
//
// --radius is in pixels from spawn in every direction, so the default 5000 covers a
// 10000x10000 area. Regions are 256x256 pixels and are the unit of storage, so the
// filled area is rounded outwards to whole regions.
//
// --mode noise  : every pixel an independent random colour. Incompressible, so this is
//                 the worst case for both the on-disk encoding and the wire encoding.
// --mode blocks : random axis-aligned rectangles of flat colour. Compresses like a real
//                 world does, and is far smaller on disk.

import { Level } from "level"
import { saveData } from "../src/region/regionData.js"

const REGION_SIZE = 256                     // pixels per region axis
const REGION_PIXEL_BYTES = 196608           // 256 * 256 * 3

function parseArgs(argv) {
  const args = { world: "main", radius: 5000, mode: "noise", seed: 1 }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith("--")) continue
    const name = key.slice(2)
    const value = argv[++i]
    if (value === undefined) throw new Error(`missing value for --${name}`)
    if (name === "world") args.world = value
    else if (name === "radius") args.radius = parseInt(value, 10)
    else if (name === "mode") args.mode = value
    else if (name === "seed") args.seed = parseInt(value, 10)
    else throw new Error(`unknown option --${name}`)
  }
  if (!Number.isInteger(args.radius) || args.radius <= 0) throw new Error("--radius must be a positive integer")
  if (args.mode !== "noise" && args.mode !== "blocks") throw new Error("--mode must be 'noise' or 'blocks'")
  return args
}

// Deterministic PRNG so a given --seed reproduces the same world exactly.
function makeRandom(seed) {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    // xorshift32
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state
  }
}

function fillNoise(pixels, rand) {
  for (let i = 0; i < REGION_PIXEL_BYTES; i += 3) {
    const r = rand()
    pixels[i] = r & 0xff
    pixels[i + 1] = (r >>> 8) & 0xff
    pixels[i + 2] = (r >>> 16) & 0xff
  }
}

function fillBlocks(pixels, rand) {
  // start from a flat background so untouched areas still compress well
  const bg = rand()
  pixels.fill(Buffer.from([bg & 0xff, (bg >>> 8) & 0xff, (bg >>> 16) & 0xff]))
  const rectangles = 24 + (rand() % 40)
  for (let n = 0; n < rectangles; n++) {
    const c = rand()
    const r = c & 0xff, g = (c >>> 8) & 0xff, b = (c >>> 16) & 0xff
    const w = 4 + (rand() % 64)
    const h = 4 + (rand() % 64)
    const x0 = rand() % REGION_SIZE
    const y0 = rand() % REGION_SIZE
    const x1 = Math.min(REGION_SIZE, x0 + w)
    const y1 = Math.min(REGION_SIZE, y0 + h)
    for (let y = y0; y < y1; y++) {
      let p = (y * REGION_SIZE + x0) * 3
      for (let x = x0; x < x1; x++) {
        pixels[p++] = r
        pixels[p++] = g
        pixels[p++] = b
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // Region coordinates are pixel coordinates shifted right by 8, which floors correctly
  // for negatives too, so this rounds the requested area outwards to whole regions.
  const minRegion = (-args.radius) >> 8
  const maxRegion = (args.radius - 1) >> 8
  const perAxis = maxRegion - minRegion + 1
  const totalRegions = perAxis * perAxis

  console.log(`world           : ${args.world}`)
  console.log(`requested area  : ${args.radius * 2} x ${args.radius * 2} pixels centred on spawn`)
  console.log(`region range    : ${minRegion}..${maxRegion} on both axes (${perAxis} x ${perAxis} = ${totalRegions} regions)`)
  console.log(`covered area    : ${perAxis * REGION_SIZE} x ${perAxis * REGION_SIZE} pixels`)
  console.log(`mode            : ${args.mode}`)
  console.log(`seed            : ${args.seed}`)
  console.log("")

  const db = new Level("./data/regions", { keyEncoding: "utf8", valueEncoding: "buffer" })
  try {
    await db.open()
  } catch (err) {
    console.error("Failed to open ./data/regions - is the server still running? LevelDB needs an exclusive lock.")
    console.error(String(err.message ?? err))
    process.exit(1)
  }

  const rand = makeRandom(args.seed)
  const pixels = Buffer.allocUnsafe(REGION_PIXEL_BYTES)
  const protection = Buffer.alloc(256) // 0 = unprotected

  const started = Date.now()
  let written = 0
  let bytes = 0
  let batch = db.batch()
  let batched = 0

  for (let ry = minRegion; ry <= maxRegion; ry++) {
    for (let rx = minRegion; rx <= maxRegion; rx++) {
      if (args.mode === "noise") fillNoise(pixels, rand)
      else fillBlocks(pixels, rand)

      const regionId = (rx + 0x10000) + ((ry + 0x10000) * 0x20000)
      const data = saveData(protection, pixels)
      batch.put(`${args.world}-${regionId}`, data)
      bytes += data.length
      batched++
      written++

      if (batched >= 64) {
        await batch.write()
        batch = db.batch()
        batched = 0
        const pct = ((written / totalRegions) * 100).toFixed(1)
        const mb = (bytes / 1048576).toFixed(1)
        process.stdout.write(`\r${written}/${totalRegions} regions (${pct}%), ${mb} MiB encoded`)
      }
    }
  }
  if (batched > 0) await batch.write()

  await db.close()

  const seconds = (Date.now() - started) / 1000
  console.log(`\r${written}/${totalRegions} regions (100.0%), ${(bytes / 1048576).toFixed(1)} MiB encoded`)
  console.log("")
  console.log(`Done in ${seconds.toFixed(1)}s.`)
  console.log(`Wrote ${written} regions totalling ${(bytes / 1048576).toFixed(1)} MiB of encoded pixel data.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
