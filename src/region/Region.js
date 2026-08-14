import { loadData, saveData } from "./regionData.js"

let chunkBufferA = Buffer.allocUnsafeSlow(184)
chunkBufferA[0] = 0x02
chunkBufferA.writeUint16LE(768, 10)
let chunkBufferB = Buffer.allocUnsafeSlow(768)

let erasedChunkTemplate = Buffer.from("020000000000000000000003010000000001000000", "hex")

export class Region {
  constructor(world, id) {
    this.world = world
    this.server = world.server
    this.x = id % 0x20000 - 0x10000
    this.y = Math.floor(id / 0x20000) - 0x10000
    this.id = id
    this.dbId = `${world.name}-${id}`
    this.loaded = false
    this.beganLoading = false
    this.isEmpty = null
    this.latestDataBuffer = null
    this.pixels = null
    this.protection = null
    this.lastHeld = this.server.currentTick
    this.loadPromise = null
    this.dataModified = false
    this.lodCache = null // cached downsample, see getLodData

    this.destroyed = false
  }

  async load() {
    this.loadPromise = this.internalLoad()
  }

  async internalLoad() {
    this.beganLoading = true
    let data = await this.server.regions.getData(this.dbId)
    this.loaded = true
    this.loadPromise = null
    this.latestDataBuffer = data
    if (!data) {
      this.isEmpty = true
      let color = this.world.bgcolor.value
      this.pixels = Buffer.alloc(196608, new Uint8Array([color >> 16, (color & 0x00ff00) >> 8, color & 0x0000ff]))
      this.protection = Buffer.alloc(256)
      return
    }
    loadData(this, data)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.save()
    this.world.regionDestroyed(this.id)
  }

  save() {
    if (this.loaded && this.dataModified) {
      this.server.regions.setData(this.dbId, this.getFreshDataBuffer())
      this.dataModified = false
    }
  }

  flagDataModified() {
    this.isEmpty = false
    this.dataModified = true
    this.latestDataBuffer = null // allow gc of outdated db buffer
    this.lodCache = null // downsample no longer reflects the pixels
  }

  // One averaged colour per chunk, so a whole region is 768 bytes instead of the ~200KB
  // its 256 chunks cost at full detail. Used to paint a zoomed-out view immediately.
  // Ordered by chunk location, i.e. localChunkY * 16 + localChunkX, matching getChunkData.
  getLodData() {
    if (this.lodCache) return this.lodCache
    let out = Buffer.allocUnsafeSlow(768)
    if (this.isEmpty === true || !this.pixels) {
      let color = this.world.bgcolor.value
      let r = color >> 16, g = (color & 0x00ff00) >> 8, b = color & 0x0000ff
      for (let i = 0; i < 256; i++) {
        out[i * 3] = r
        out[i * 3 + 1] = g
        out[i * 3 + 2] = b
      }
      this.lodCache = out
      return out
    }
    for (let chunkLocation = 0; chunkLocation < 256; chunkLocation++) {
      let base = chunkLocation * 768
      let r = 0, g = 0, b = 0
      for (let i = 0; i < 768; i += 3) {
        r += this.pixels[base + i]
        g += this.pixels[base + i + 1]
        b += this.pixels[base + i + 2]
      }
      let o = chunkLocation * 3
      out[o] = (r / 256) | 0
      out[o + 1] = (g / 256) | 0
      out[o + 2] = (b / 256) | 0
    }
    this.lodCache = out
    return out
  }

  updateDataBuffer() {
    this.latestDataBuffer = saveData(this.protection, this.pixels) // could be in a separate thread?
    return this.latestDataBuffer
  }

  getFreshDataBuffer() {
    // if the region is not loaded we can still return it from db, since it has cache no unnecessary fetches should occur
    // TODO: should think about the impact of deferred pixel updates and simultaneous region requests (packet ordering)
    if (!this.loaded) return this.server.regions.getData(this.dbId)
    if (this.isEmpty === true) return null
    return this.latestDataBuffer ? this.latestDataBuffer : this.updateDataBuffer();
  }

  keepAlive(tick) {
    //always keep this region if it hasn't been loaded yet, otherwise bugs could occur from clients awaiting loading
    if (!this.loaded && this.loadPromise) return true
    //if the region has been modified, keep it around a little longer because it may be modified again
    if (this.dataModified) return tick - this.lastHeld < 450
    //if it hasn't been modified, this might just be a region someone is passing through and won't need again
    //so destroy it after a shorter period
    return tick - this.lastHeld < 150
  }

  getChunkData(chunkLocation) {
    let data = this.pixels.subarray(chunkLocation * 768, chunkLocation * 768 + 768)
    let relativeChunkX = chunkLocation & 0x0f
    let relativeChunkY = chunkLocation >> 4
    chunkBufferA.writeInt32LE((this.x << 4) + relativeChunkX, 1)
    chunkBufferA.writeInt32LE((this.y << 4) + relativeChunkY, 5)
    chunkBufferA[9] = this.protection[chunkLocation]
    let aBufIndex = 14
    let bBufIndex = 0
    let lastColor = data[2] << 16 | data[1] << 8 | data[0]
    let repeat = 1
    for (let i = 3; i < 768; i += 3) {
      let color = data[i + 2] << 16 | data[i + 1] << 8 | data[i]
      if (color === lastColor) {
        repeat++
      } else {
        if (repeat >= 3) {
          chunkBufferA.writeUint16LE(bBufIndex, aBufIndex)
          aBufIndex += 2
          chunkBufferB.writeUint16LE(repeat, bBufIndex)
          bBufIndex += 2
          chunkBufferB[bBufIndex++] = data[i - 3]
          chunkBufferB[bBufIndex++] = data[i - 2]
          chunkBufferB[bBufIndex++] = data[i - 1]
        } else {
          let bytes = 3 * repeat
          let start = i - bytes
          for (let j = start; j < i; j++) {
            chunkBufferB[bBufIndex++] = data[j]
          }
        }
        repeat = 1
        lastColor = color
      }
    }
    if (repeat >= 3) {
      chunkBufferA.writeUint16LE(bBufIndex, aBufIndex)
      aBufIndex += 2
      chunkBufferB.writeUint16LE(repeat, bBufIndex)
      bBufIndex += 2
      chunkBufferB[bBufIndex++] = data[765]
      chunkBufferB[bBufIndex++] = data[766]
      chunkBufferB[bBufIndex++] = data[767]
    } else {
      let bytes = 3 * repeat
      let start = 768 - bytes
      for (let j = start; j < 768; j++) {
        chunkBufferB[bBufIndex++] = data[j]
      }
    }
    chunkBufferA.writeUint16LE((aBufIndex - 14) / 2, 12)
    //must be allocUnsafeSlow and do copying manually, otherwise buffer pool gets used and the arrayBuffer contains extra data that uWS would send
    let out = Buffer.allocUnsafeSlow(aBufIndex + bBufIndex)
    chunkBufferA.copy(out)
    chunkBufferB.copy(out, aBufIndex)
    return out
  }

  requestChunk(client, chunkLocation) {
    this.lastHeld = this.server.currentTick
    client.ws.send(this.getChunkData(chunkLocation).buffer, true)
  }

  async requestRegion(client) {
    this.lastHeld = this.server.currentTick
    // if the region is currently loading, we wait, because there could be deferred actions that modify its data
    // maybe it doesn't matter if we can guarantee that all updates will be received by the client after sending buf,
    // but does that happen?
    //if (this.loadPromise) await this.loadPromise
    //if (client.destroyed) return

    // if not loaded, it will attach to the cache db promise. it should send the packet before any deferred action is sent
    let buf = this.getFreshDataBuffer()
    if (buf && buf.constructor === Promise) {
      // the load already is ongoing, but it doesn't really matter to have accepted one more
      if (client.rank < 3 && !client.regionloadquota.canSpend()) {
        this.server.adminMessage(`DEVKicked ${client.uid} (${client.world.name}, ${client.ip.ip}) for loading too many regions`)
        this.destroy()
        return false
      }
      buf = await buf
    }
    if (client.destroyed) return

    let pkt = null;
    if (buf) { //region not empty
      pkt = Buffer.allocUnsafeSlow(1 + buf.length);
      pkt[0] = 0x0A // LOAD_REGION
      buf.copy(pkt, 1)
    } else { //region empty
      let color = this.world.bgcolor.value
      pkt = Buffer.allocUnsafeSlow(1 + 4 + 4 + 3);
      pkt[0] = 0x09 // LOAD_REGION_EMPTY
      pkt.writeInt32LE(this.x, 1)
      pkt.writeInt32LE(this.y, 5)
      pkt[9] = color >> 16
      pkt[10] = (color & 0x00ff00) >> 8
      pkt[11] = color & 0x0000ff
    }

    client.ws.send(pkt.buffer, true)
  }

  setPixel(client, x, y, r, g, b) {
    this.lastHeld = this.server.currentTick
    let chunkId = (y & 0xf0) + (x >> 4)
    let chunkRelativePos = ((y & 0xf) << 4) + (x & 0xf)
    let bufferPos = ((chunkId << 8) | chunkRelativePos) * 3
    if (this.pixels[bufferPos] === r && this.pixels[bufferPos + 1] === g && this.pixels[bufferPos + 2] === b) return
    if (client.rank < 2 && this.protection[chunkId]) return
    if (this.world.pixelUpdates.length >= 65535) return
    this.server.stats.currentPixelsPlaced++
    this.pixels[bufferPos] = r
    this.pixels[bufferPos + 1] = g
    this.pixels[bufferPos + 2] = b
    this.flagDataModified()
    let realX = (this.x << 8) + x
    let realY = (this.y << 8) + y
    let buffer = Buffer.allocUnsafe(15)
    buffer.writeUint32LE(client.uid, 0)
    buffer.writeInt32LE(realX, 4)
    buffer.writeInt32LE(realY, 8)
    buffer[12] = r
    buffer[13] = g
    buffer[14] = b
    this.world.pixelUpdates.push(buffer)
  }

  pasteChunk(chunkLocation, data) {
    this.lastHeld = this.server.currentTick
    this.flagDataModified()
    data.copy(this.pixels, chunkLocation * 768)
    this.world.broadcastBuffer(this.getChunkData(chunkLocation))
  }

  eraseChunk(chunkLocation, r, g, b) {
    this.lastHeld = this.server.currentTick
    this.flagDataModified()
    this.pixels.fill(new Uint8Array([r, g, b]), chunkLocation * 768, chunkLocation * 768 + 768)
    let buffer = Buffer.allocUnsafeSlow(21)
    erasedChunkTemplate.copy(buffer)
    let relativeChunkX = chunkLocation & 0x0f
    let relativeChunkY = chunkLocation >> 4
    buffer.writeInt32LE((this.x << 4) + relativeChunkX, 1)
    buffer.writeInt32LE((this.y << 4) + relativeChunkY, 5)
    buffer[9] = this.protection[chunkLocation]
    buffer[18] = r
    buffer[19] = g
    buffer[20] = b
    this.world.broadcastBuffer(buffer)
  }

  protectChunk(chunkLocation, isProtected) {
    this.lastHeld = this.server.currentTick
    if (this.protection[chunkLocation] === isProtected) return
    this.flagDataModified()
    this.protection[chunkLocation] = isProtected
    let buffer = Buffer.allocUnsafeSlow(10)
    buffer[0] = 0x07
    let relativeChunkX = chunkLocation & 0x0f
    let relativeChunkY = chunkLocation >> 4
    buffer.writeInt32LE((this.x << 4) + relativeChunkX, 1)
    buffer.writeInt32LE((this.y << 4) + relativeChunkY, 5)
    buffer[9] = isProtected
    this.world.broadcastBuffer(buffer)
  }
}
