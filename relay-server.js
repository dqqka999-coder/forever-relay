// relay-server.js
// npm install express cors
// node relay-server.js

const express = require('express')
const cors    = require('cors')
const app     = express()
const PORT    = process.env.PORT || 8080

// Allow larger payloads for base64 avatar uploads (~300 KB limit)
app.use(cors())
app.use(express.json({ limit: '400kb' }))

// ── DATA STORES ───────────────────────────────────────────────────────────────
const users      = new Map()
const friends    = new Map()
const pending    = new Map()
const jamInvites = new Map()
const jamSessions = new Map()
const dms        = new Map()
const dmUnread   = new Map()
// avatars: { username -> { dataUrl, updatedAt } }
const avatars    = new Map()

const TIMEOUT    = 30000
const MAX_AVATAR = 300_000

function touch(username) {
  if (users.has(username)) users.get(username).lastSeen = Date.now()
}

function isOnline(username) {
  const u = users.get(username)
  return u && (Date.now() - u.lastSeen < TIMEOUT)
}

function auth(req, res) {
  const { username, token } = req.body || req.query || {}
  if (!username || !token) { res.status(400).json({ error: 'missing_fields' }); return null }
  const u = users.get(username)
  if (!u || u.token !== token) { res.status(401).json({ error: 'bad_token' }); return null }
  touch(username)
  return username
}

function dmKey(a, b) { return [a,b].sort().join(':') }

// ── REGISTER ──────────────────────────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { username, token } = req.body
  if (!username || !token) return res.json({ error: 'missing_fields' })

  if (users.has(username)) {
    const u = users.get(username)
    if (u.token !== token) return res.json({ error: 'username_taken' })
    u.lastSeen = Date.now()
    return res.json({ ok: true })
  }

  users.set(username, { token, playing: false, title: '', artist: '', currentTime: 0, duration: 0, lastSeen: Date.now() })
  if (!friends.has(username))  friends.set(username, new Set())
  if (!pending.has(username))  pending.set(username, [])
  if (!dmUnread.has(username)) dmUnread.set(username, [])
  res.json({ ok: true })
})

// ── PRESENCE CHECK ────────────────────────────────────────────────────────────
app.get('/presence', (req, res) => res.json({ ok: true }))

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
app.post('/heartbeat', (req, res) => {
  const username = auth(req, res); if (!username) return
  const u = users.get(username)
  const { playing, title, artist, currentTime, duration } = req.body
  u.playing     = !!playing
  u.title       = title    || ''
  u.artist      = artist   || ''
  u.currentTime = currentTime || 0
  u.duration    = duration || 0
  res.json({ ok: true })
})

// ── LEAVE ─────────────────────────────────────────────────────────────────────
app.post('/leave', (req, res) => {
  const { username, token } = req.body
  const u = users.get(username)
  if (u && u.token === token) {
    u.lastSeen = 0
    for (const [jamId, jam] of jamSessions) {
      if (jam.members.has(username)) {
        jam.members.delete(username)
        if (jam.members.size === 0) jamSessions.delete(jamId)
      }
    }
  }
  res.json({ ok: true })
})

// ── FRIEND REQUEST ────────────────────────────────────────────────────────────
app.post('/friend-request', (req, res) => {
  const { from, to, token } = req.body
  const uf = users.get(from)
  if (!uf || uf.token !== token) return res.status(401).json({ error: 'bad_token' })
  if (!users.has(to)) return res.json({ error: 'user_not_found' })
  touch(from)
  const myFriends = friends.get(from) || new Set()
  if (myFriends.has(to)) return res.json({ already: true })
  const list = pending.get(to) || []
  if (!list.find(r => r.from === from)) {
    list.push({ from, ts: Date.now() })
    pending.set(to, list)
  }
  res.json({ ok: true })
})

// ── FRIEND REQUESTS LIST ──────────────────────────────────────────────────────
app.get('/friend-requests/:username', (req, res) => {
  const { username } = req.params
  const { token } = req.query
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  res.json(pending.get(username) || [])
})

// ── FRIEND RESPONSE ───────────────────────────────────────────────────────────
app.post('/friend-response', (req, res) => {
  const { from, to, accept, token } = req.body
  const u = users.get(to)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(to)
  const list = pending.get(to) || []
  const idx  = list.findIndex(r => r.from === from)
  if (idx >= 0) list.splice(idx, 1)
  pending.set(to, list)
  if (accept) {
    if (!friends.has(from)) friends.set(from, new Set())
    if (!friends.has(to))   friends.set(to,   new Set())
    friends.get(from).add(to)
    friends.get(to).add(from)
  }
  res.json({ ok: true })
})

// ── FRIENDS LIST ──────────────────────────────────────────────────────────────
app.get('/friends/:username', (req, res) => {
  const { username } = req.params
  const { token } = req.query
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const myFriends = friends.get(username) || new Set()
  const result = [...myFriends].map(name => {
    const f = users.get(name)
    const online = isOnline(name)
    const av = avatars.get(name)
    return {
      username: name,
      online,
      playing:        online ? (f?.playing     || false) : false,
      title:          online ? (f?.title       || '')    : '',
      artist:         online ? (f?.artist      || '')    : '',
      currentTime:    online ? (f?.currentTime || 0)     : 0,
      duration:       online ? (f?.duration    || 0)     : 0,
      hasAvatar:      !!av,
      avatarUpdatedAt: av?.updatedAt || null,
    }
  })
  res.json(result)
})

// ── UPLOAD AVATAR ─────────────────────────────────────────────────────────────
app.post('/avatar', (req, res) => {
  const username = auth(req, res); if (!username) return
  const { dataUrl } = req.body
  if (!dataUrl || typeof dataUrl !== 'string')
    return res.status(400).json({ error: 'missing_dataUrl' })
  if (!dataUrl.startsWith('data:image/'))
    return res.status(400).json({ error: 'invalid_format' })
  if (dataUrl.length > MAX_AVATAR)
    return res.status(413).json({ error: 'avatar_too_large', maxBytes: MAX_AVATAR })
  avatars.set(username, { dataUrl, updatedAt: Date.now() })
  res.json({ ok: true })
})

// ── DELETE AVATAR ─────────────────────────────────────────────────────────────
app.delete('/avatar', (req, res) => {
  const username = auth(req, res); if (!username) return
  avatars.delete(username)
  res.json({ ok: true })
})

// ── GET AVATAR ────────────────────────────────────────────────────────────────
app.get('/avatar/:target', (req, res) => {
  const { target } = req.params
  const { username, token } = req.query
  const u = users.get(username)
  if (!username || !token || !u || u.token !== token)
    return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const isSelf   = username === target
  const isFriend = friends.get(username)?.has(target)
  if (!isSelf && !isFriend)
    return res.status(403).json({ error: 'not_friends' })
  const av = avatars.get(target)
  if (!av) return res.status(404).json({ error: 'no_avatar' })
  res.json({ dataUrl: av.dataUrl, updatedAt: av.updatedAt })
})

// ── JAM INVITE ────────────────────────────────────────────────────────────────
app.post('/jam-invite', (req, res) => {
  const { from, to, token, title, artist } = req.body
  const uf = users.get(from)
  if (!uf || uf.token !== token) return res.status(401).json({ error: 'bad_token' })
  if (!users.has(to)) return res.json({ error: 'user_not_found' })
  touch(from)
  let jamId = null
  for (const [id, jam] of jamSessions) {
    if (jam.host === from) { jamId = id; break }
  }
  if (!jamId) {
    jamId = `jam_${Date.now()}_${from}`
    jamSessions.set(jamId, {
      host: from,
      title: title || uf.title || '',
      artist: artist || uf.artist || '',
      currentTime: uf.currentTime || 0,
      playing: uf.playing || false,
      lastUpdate: Date.now(),
      members: new Set([from])
    })
  }
  jamInvites.set(to, { from, title: title || '', jamId, ts: Date.now() })
  res.json({ ok: true, jamId })
})

// ── POLL JAM INVITE ───────────────────────────────────────────────────────────
app.get('/jam-invite/:username', (req, res) => {
  const { username } = req.params
  const { token } = req.query
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const invite = jamInvites.get(username)
  if (invite && Date.now() - invite.ts < 60000) {
    res.json({ pending: true, from: invite.from, title: invite.title, jamId: invite.jamId })
  } else {
    res.json({ pending: false })
  }
})

// ── CLEAR JAM INVITE ──────────────────────────────────────────────────────────
app.post('/jam-clear/:username', (req, res) => {
  const { username } = req.params
  const { token } = req.body
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  jamInvites.delete(username)
  res.json({ ok: true })
})

// ── JOIN JAM ──────────────────────────────────────────────────────────────────
app.post('/jam-join', (req, res) => {
  const { username, token, jamId } = req.body
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const jam = jamSessions.get(jamId)
  if (!jam) return res.json({ error: 'jam_not_found' })
  jam.members.add(username)
  jamInvites.delete(username)
  let syncTime = jam.currentTime
  if (jam.playing && jam.lastUpdate) {
    syncTime += (Date.now() - jam.lastUpdate) / 1000
  }
  res.json({ ok: true, host: jam.host, title: jam.title, artist: jam.artist, currentTime: syncTime, playing: jam.playing })
})

// ── JAM SYNC (host pushes position) ──────────────────────────────────────────
app.post('/jam-sync', (req, res) => {
  const { username, token, jamId, currentTime, playing, title, artist } = req.body
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const jam = jamSessions.get(jamId)
  if (!jam) return res.json({ error: 'jam_not_found' })
  if (jam.host !== username) return res.json({ error: 'not_host' })
  jam.currentTime = currentTime ?? jam.currentTime
  jam.playing     = playing     ?? jam.playing
  jam.title       = title       ?? jam.title
  jam.artist      = artist      ?? jam.artist
  jam.lastUpdate  = Date.now()
  res.json({ ok: true })
})

// ── GET JAM STATE ─────────────────────────────────────────────────────────────
app.get('/jam-state/:jamId', (req, res) => {
  const { jamId } = req.params
  const { username, token } = req.query
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const jam = jamSessions.get(jamId)
  if (!jam) return res.json({ error: 'jam_not_found' })
  let syncTime = jam.currentTime
  if (jam.playing && jam.lastUpdate) {
    syncTime += (Date.now() - jam.lastUpdate) / 1000
  }
  res.json({ host: jam.host, title: jam.title, artist: jam.artist, currentTime: syncTime, playing: jam.playing, members: [...jam.members].filter(m => isOnline(m)) })
})

// ── LEAVE JAM ─────────────────────────────────────────────────────────────────
app.post('/jam-leave', (req, res) => {
  const { username, token, jamId } = req.body
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const jam = jamSessions.get(jamId)
  if (jam) {
    jam.members.delete(username)
    if (jam.members.size === 0) jamSessions.delete(jamId)
  }
  res.json({ ok: true })
})

// ── SEND DM ───────────────────────────────────────────────────────────────────
app.post('/dm/send', (req, res) => {
  const { from, to, token, text } = req.body
  const u = users.get(from)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  if (!users.has(to)) return res.json({ error: 'user_not_found' })
  if (!text?.trim()) return res.json({ error: 'empty_message' })
  touch(from)
  const key = dmKey(from, to)
  if (!dms.has(key)) dms.set(key, [])
  const msg = { from, text: text.trim(), ts: Date.now() }
  dms.get(key).push(msg)
  if (!dmUnread.has(to)) dmUnread.set(to, [])
  dmUnread.get(to).push(msg)
  res.json({ ok: true, ts: msg.ts })
})

// ── GET DM HISTORY ────────────────────────────────────────────────────────────
app.get('/dm/history', (req, res) => {
  const { username, token, with: withUser } = req.query
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  res.json(dms.get(dmKey(username, withUser)) || [])
})

// ── POLL UNREAD DMs ───────────────────────────────────────────────────────────
app.get('/dm/unread/:username', (req, res) => {
  const { username } = req.params
  const { token } = req.query
  const u = users.get(username)
  if (!u || u.token !== token) return res.status(401).json({ error: 'bad_token' })
  touch(username)
  const msgs = dmUnread.get(username) || []
  dmUnread.set(username, [])
  res.json(msgs)
})

// ── CLEANUP ───────────────────────────────────────────────────────────────────
setInterval(() => {
  for (const [username, u] of users) {
    if (Date.now() - u.lastSeen > 120000) {
      users.delete(username)
      avatars.delete(username)
    }
  }
  for (const [jamId, jam] of jamSessions) {
    for (const m of jam.members) {
      if (!isOnline(m)) jam.members.delete(m)
    }
    if (jam.members.size === 0) jamSessions.delete(jamId)
  }
}, 60000)

app.listen(PORT, () => console.log(`🎵 Music relay running on http://localhost:${PORT}`))
