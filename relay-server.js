/**
 * forever · relay server
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this once on any machine/VPS accessible by all your friends.
 * e.g.  node relay-server.js
 *
 * Default port: 4587  (set PORT env var to change)
 * No database — all state is in-memory. Restarts wipe presence but not much else matters.
 *
 * API used by the forever app:
 *   POST /register         { username, token }  → register/heartbeat
 *   GET  /presence/:user   → { username, playing, title, artist, online, updatedAt }
 *   GET  /presence         → all online users
 *   POST /friend-request   { from, to }         → send a friend request
 *   GET  /friend-requests/:user                 → pending incoming requests for :user
 *   POST /friend-response  { from, to, accept } → accept/decline
 *   GET  /friends/:user                         → confirmed friends list
 *   POST /jam-invite       { from, to, title, artist } → send jam invite
 *   GET  /jam-invite/:user                      → pending jam invite for :user (poll)
 *   POST /jam-clear/:user                       → clear pending jam invite
 *   POST /heartbeat        { username, token, playing, title, artist, currentTime, duration }
 *   POST /leave            { username, token }
 */

const http = require('http')
const PORT = process.env.PORT || 4587

// ── IN-MEMORY STATE ───────────────────────────────────────────────────────────
// users:    username → { token, playing, title, artist, currentTime, duration, updatedAt }
// friends:  username → Set<username>  (bidirectional, stored once each side)
// requests: username → { from, createdAt }[]   (pending incoming requests)
// jams:     username → { from, title, artist, createdAt } | null
const users    = new Map()
const friends  = new Map()
const requests = new Map()
const jams     = new Map()

const ONLINE_TTL   = 30000  // 30s — user considered offline if no heartbeat
const REQUEST_TTL  = 120000 // 2 min — friend requests expire
const JAM_TTL      = 60000  // 1 min — jam invites expire

// ── HELPERS ───────────────────────────────────────────────────────────────────
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(data))
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => data += c)
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

function isOnline(user) {
  return user && (Date.now() - user.updatedAt) < ONLINE_TTL
}

function getFriends(username) {
  return Array.from(friends.get(username) || [])
}

function addFriend(a, b) {
  if (!friends.has(a)) friends.set(a, new Set())
  if (!friends.has(b)) friends.set(b, new Set())
  friends.get(a).add(b)
  friends.get(b).add(a)
}

function areFriends(a, b) {
  return (friends.get(a) || new Set()).has(b)
}

function cleanExpired() {
  const now = Date.now()
  // Clean expired friend requests
  for (const [user, reqs] of requests.entries()) {
    const fresh = reqs.filter(r => now - r.createdAt < REQUEST_TTL)
    if (fresh.length !== reqs.length) requests.set(user, fresh)
  }
  // Clean expired jam invites
  for (const [user, jam] of jams.entries()) {
    if (jam && now - jam.createdAt > JAM_TTL) jams.set(user, null)
  }
}
setInterval(cleanExpired, 15000)

// ── REQUEST ROUTER ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    return res.end()
  }

  const url   = new URL(req.url, `http://localhost:${PORT}`)
  const path  = url.pathname
  const parts = path.split('/').filter(Boolean)

  // ── POST /register ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/register') {
    const b = await body(req)
    const { username, token } = b
    if (!username || !token || username.length > 32) return send(res, 400, { error: 'bad request' })

    // Check username taken by a different token
    const existing = users.get(username)
    if (existing && existing.token !== token && isOnline(existing)) {
      return send(res, 409, { error: 'username_taken' })
    }

    users.set(username, {
      token,
      playing: false, title: '', artist: '', currentTime: 0, duration: 0,
      updatedAt: Date.now()
    })
    if (!friends.has(username)) friends.set(username, new Set())
    if (!requests.has(username)) requests.set(username, [])
    console.log(`[register] ${username}`)
    return send(res, 200, { ok: true })
  }

  // ── POST /heartbeat ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/heartbeat') {
    const b = await body(req)
    const { username, token } = b
    const user = users.get(username)
    if (!user || user.token !== token) return send(res, 401, { error: 'unauthorized' })
    Object.assign(user, {
      playing: b.playing || false,
      title:   b.title   || '',
      artist:  b.artist  || '',
      currentTime: b.currentTime || 0,
      duration: b.duration || 0,
      updatedAt: Date.now()
    })
    return send(res, 200, { ok: true })
  }

  // ── POST /leave ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/leave') {
    const b = await body(req)
    const { username, token } = b
    const user = users.get(username)
    if (user && user.token === token) {
      user.updatedAt = 0 // mark offline immediately
    }
    return send(res, 200, { ok: true })
  }

  // ── GET /presence ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/presence') {
    const all = []
    for (const [name, user] of users.entries()) {
      if (isOnline(user)) {
        all.push({ username: name, playing: user.playing, title: user.title, artist: user.artist })
      }
    }
    return send(res, 200, all)
  }

  // ── GET /presence/:user ─────────────────────────────────────────────────────
  if (req.method === 'GET' && parts[0] === 'presence' && parts[1]) {
    const user = users.get(parts[1])
    if (!user) return send(res, 404, { error: 'not_found' })
    return send(res, 200, {
      username: parts[1],
      online: isOnline(user),
      playing: user.playing,
      title:   user.title,
      artist:  user.artist,
      currentTime: user.currentTime,
      duration: user.duration,
      updatedAt: user.updatedAt
    })
  }

  // ── POST /friend-request ────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/friend-request') {
    const b = await body(req)
    const { from, to, token } = b
    const sender = users.get(from)
    if (!sender || sender.token !== token) return send(res, 401, { error: 'unauthorized' })
    if (!users.has(to)) return send(res, 404, { error: 'user_not_found' })
    if (areFriends(from, to)) return send(res, 200, { ok: true, already: true })

    // Don't stack duplicate requests
    const pending = requests.get(to) || []
    if (!pending.find(r => r.from === from)) {
      pending.push({ from, createdAt: Date.now() })
      requests.set(to, pending)
    }
    console.log(`[friend-request] ${from} → ${to}`)
    return send(res, 200, { ok: true })
  }

  // ── GET /friend-requests/:user ──────────────────────────────────────────────
  if (req.method === 'GET' && parts[0] === 'friend-requests' && parts[1]) {
    const username = parts[1]
    const token = url.searchParams.get('token')
    const user = users.get(username)
    if (!user || user.token !== token) return send(res, 401, { error: 'unauthorized' })
    const reqs = (requests.get(username) || []).filter(r => Date.now() - r.createdAt < REQUEST_TTL)
    return send(res, 200, reqs)
  }

  // ── POST /friend-response ───────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/friend-response') {
    const b = await body(req)
    const { from, to, accept, token } = b
    const user = users.get(to)
    if (!user || user.token !== token) return send(res, 401, { error: 'unauthorized' })

    // Remove the request regardless of accept/decline
    const reqs = requests.get(to) || []
    requests.set(to, reqs.filter(r => r.from !== from))

    if (accept) {
      addFriend(from, to)
      console.log(`[friends] ${from} ↔ ${to}`)
    }
    return send(res, 200, { ok: true })
  }

  // ── GET /friends/:user ──────────────────────────────────────────────────────
  if (req.method === 'GET' && parts[0] === 'friends' && parts[1]) {
    const username = parts[1]
    const token = url.searchParams.get('token')
    const user = users.get(username)
    if (!user || user.token !== token) return send(res, 401, { error: 'unauthorized' })

    const fList = getFriends(username).map(name => {
      const u = users.get(name)
      return {
        username: name,
        online:   u ? isOnline(u) : false,
        playing:  u?.playing || false,
        title:    u?.title   || '',
        artist:   u?.artist  || '',
        currentTime: u?.currentTime || 0,
        duration: u?.duration || 0
      }
    })
    return send(res, 200, fList)
  }

  // ── POST /jam-invite ────────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/jam-invite') {
    const b = await body(req)
    const { from, to, title, artist, token } = b
    const sender = users.get(from)
    if (!sender || sender.token !== token) return send(res, 401, { error: 'unauthorized' })
    if (!areFriends(from, to)) return send(res, 403, { error: 'not_friends' })
    jams.set(to, { from, title: title || '', artist: artist || '', createdAt: Date.now() })
    console.log(`[jam] ${from} → ${to}`)
    return send(res, 200, { ok: true })
  }

  // ── GET /jam-invite/:user ───────────────────────────────────────────────────
  if (req.method === 'GET' && parts[0] === 'jam-invite' && parts[1]) {
    const username = parts[1]
    const token = url.searchParams.get('token')
    const user = users.get(username)
    if (!user || user.token !== token) return send(res, 401, { error: 'unauthorized' })
    const jam = jams.get(username)
    if (!jam || Date.now() - jam.createdAt > JAM_TTL) return send(res, 200, { pending: false })
    return send(res, 200, { pending: true, ...jam })
  }

  // ── POST /jam-clear/:user ───────────────────────────────────────────────────
  if (req.method === 'POST' && parts[0] === 'jam-clear' && parts[1]) {
    const username = parts[1]
    const b = await body(req)
    const user = users.get(username)
    if (!user || user.token !== b.token) return send(res, 401, { error: 'unauthorized' })
    jams.set(username, null)
    return send(res, 200, { ok: true })
  }

  // ── 404 ─────────────────────────────────────────────────────────────────────
  send(res, 404, { error: 'not_found' })
})

server.listen(PORT, () => {
  console.log(`\n🎵  forever relay server running on port ${PORT}`)
  console.log(`    Share this with your friends so they can put it in Settings:\n`)
  console.log(`    If running locally:  http://YOUR_IP:${PORT}`)
  console.log(`    If on a VPS:         http://YOUR_VPS_IP:${PORT}\n`)
})
