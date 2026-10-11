// Fines Ladder API — one Vercel serverless function, data stored in Upstash Redis.
// No npm packages needed.
const crypto = require('crypto');

// ---- Settings you can change -------------------------------------------
// Admin code: type it between the quotes, e.g. 'magpies2026'. Use at least 6 characters.
// Anyone who can read this file can read the code, so keep the GitHub repo PRIVATE.
// While this is blank, the ADMIN_PIN setting in Vercel is used instead (if there is one).
const ADMIN_CODE = '7303';
// Only used the very first time the site runs. After that, manage players from the Admin screen.
const STARTING_PLAYERS = ['Ayrton', 'Greg', 'Louis', 'George', 'Spencer', 'Hamish', 'Manning', 'Reid', 'Luke', 'Jack'];
const VOTING_HOURS = 48;   // fines not decided in this time lapse
const MAX_FINE = 500;      // biggest single fine allowed, in dollars
// -------------------------------------------------------------------------

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const K = {
  players: 'fines:players', pins: 'fines:pins', fines: 'fines:fines', votes: 'fines:votes', fail: 'fines:fail:',
  bogRounds: 'fines:bog:rounds', bogVotes: 'fines:bog:votes',
};
const adminCode = () => String(ADMIN_CODE || process.env.ADMIN_PIN || '');

function err(status, message) { const e = new Error(message); e.status = status; return e; }

async function redis(commands) {
  const r = await fetch(DB_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw err(502, 'Database error (' + r.status + ')');
  return (await r.json()).map((x) => { if (x.error) throw err(502, x.error); return x.result; });
}

function toObj(flat) {
  const o = {};
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  else if (flat && typeof flat === 'object') Object.assign(o, flat);
  return o;
}
const parse = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
const parseAll = (raw) => Object.values(toObj(raw)).map(parse);
const newId = (prefix) => prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// ---- Players (stored in the database so the admin can edit them) ---------
async function getPlayers() {
  const [raw] = await redis([['HGETALL', K.players]]);
  let list = parseAll(raw);
  if (!list.length) {
    list = STARTING_PLAYERS.map((name, i) => ({ id: name, name, order: i }));
    await redis(list.map((p) => ['HSET', K.players, p.id, JSON.stringify(p)]));
  }
  return list.sort((a, b) => a.order - b.order);
}
const savePlayer = (p) => redis([['HSET', K.players, p.id, JSON.stringify(p)]]);
const activeOf = (players) => players.filter((p) => !p.removed);
// Majority of everyone except the fined player: 5 of 9 for a team of ten.
const needFor = (players) => Math.floor((activeOf(players).length - 1) / 2) + 1;

function cleanName(value, players, exceptId) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!name) throw err(400, 'Enter a name.');
  if (activeOf(players).some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) throw err(409, 'There is already a player called ' + name + '.');
  return name;
}
function findPlayer(players, id) {
  const p = players.find((x) => x.id === id);
  if (!p) throw err(400, 'Pick a player.');
  return p;
}

// ---- PINs and admin ------------------------------------------------------
function hashPin(pin) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  const a = Buffer.from(hash || '', 'hex');
  const b = crypto.scryptSync(pin, salt || '', 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function throttle(who) {
  const [n] = await redis([['GET', K.fail + who]]);
  if (Number(n) >= 8) throw err(429, 'Too many wrong tries. Try again in 10 minutes.');
}
async function recordFail(who) {
  await redis([['INCR', K.fail + who], ['EXPIRE', K.fail + who, 600]]);
}

// Checks a player's PIN. If allowCreate and they have no PIN yet, this PIN becomes theirs.
async function signIn(players, id, pin, allowCreate) {
  const player = activeOf(players).find((p) => p.id === id);
  if (!player) throw err(400, 'Pick your name first.');
  pin = String(pin || '');
  if (!/^\d{4}$/.test(pin)) throw err(400, 'PIN must be 4 digits.');
  await throttle(id);
  let [stored] = await redis([['HGET', K.pins, id]]);
  if (!stored) {
    if (!allowCreate) throw err(401, 'Sign in again to set your PIN.');
    const [set] = await redis([['HSETNX', K.pins, id, hashPin(pin)]]);
    if (set === 1) return true;
    [stored] = await redis([['HGET', K.pins, id]]);
  }
  if (!verifyPin(pin, stored)) { await recordFail(id); throw err(401, 'Wrong PIN for ' + player.name + '.'); }
  return false;
}

async function requireAdmin(code) {
  const real = adminCode();
  if (!real) throw err(403, 'Admin is switched off. Set ADMIN_CODE at the top of api/fines.js.');
  await throttle('~admin');
  const a = crypto.createHash('sha256').update(String(code || '')).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  if (!crypto.timingSafeEqual(a, b)) { await recordFail('~admin'); throw err(401, 'Wrong admin code.'); }
}

// ---- Fines ---------------------------------------------------------------
function statusOf(fine, votes, now) {
  const need = fine.need || 5;
  let yes = 0, no = 0;
  for (const v of Object.values(votes)) v === 'yes' ? yes++ : no++;
  if (yes >= need) return 'passed';
  if (no >= need) return 'failed';
  if (now > fine.deadline) return 'lapsed';
  return 'open';
}
function votesFor(fine, allVotes, players) {
  const votes = {};
  for (const p of players) { const v = allVotes[fine.id + '|' + p.id]; if (v) votes[p.id] = v; }
  return votes;
}
function cleanAmount(value) {
  const amount = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw err(400, 'Enter a dollar amount above $0.');
  if (amount > MAX_FINE) throw err(400, 'Fines are capped at $' + MAX_FINE + '.');
  return amount;
}
async function getFine(id) {
  const [raw] = await redis([['HGET', K.fines, String(id)]]);
  if (!raw) throw err(404, 'That fine no longer exists.');
  return parse(raw);
}

// ---- Best on ground ------------------------------------------------------
async function myBog(id) {
  const [votes] = await redis([['HGETALL', K.bogVotes]]);
  return Object.keys(toObj(votes)).filter((k) => k.endsWith('|' + id)).map((k) => k.split('|')[0]);
}
async function getRound(id) {
  const [raw] = await redis([['HGET', K.bogRounds, String(id)]]);
  if (!raw) throw err(404, 'That game no longer exists.');
  return parse(raw);
}
// Admin-only view: MVP leaderboard plus who has and hasn't voted in each game.
async function bogAdmin(players) {
  const [roundsRaw, votesRaw] = await redis([['HGETALL', K.bogRounds], ['HGETALL', K.bogVotes]]);
  const votes = toObj(votesRaw), active = activeOf(players);
  const tally = Object.fromEntries(active.map((p) => [p.id, { name: p.name, points: 0, threes: 0, twos: 0, ones: 0 }]));
  const rounds = parseAll(roundsRaw).sort((a, b) => b.createdAt - a.createdAt).map((r) => {
    const voted = [], missing = [];
    for (const p of players) {
      const v = votes[r.id + '|' + p.id];
      if (!v) { if (!p.removed) missing.push(p.name); continue; }
      voted.push(p.name);
      parse(v).forEach((who, i) => {
        if (!tally[who]) return;
        tally[who].points += 3 - i;
        tally[who][['threes', 'twos', 'ones'][i]]++;
      });
    }
    return { ...r, voted, missing };
  });
  const leaderboard = Object.values(tally).sort((a, b) =>
    b.points - a.points || b.threes - a.threes || b.twos - a.twos || a.name.localeCompare(b.name));
  return { rounds, leaderboard };
}

// ---- What the public page is allowed to see ------------------------------
async function getState(players) {
  const [pins, finesRaw, votesRaw, bogRaw] = await redis([['HGETALL', K.pins], ['HGETALL', K.fines], ['HGETALL', K.votes], ['HGETALL', K.bogRounds]]);
  const pinMap = toObj(pins), allVotes = toObj(votesRaw), now = Date.now();
  const fines = parseAll(finesRaw).map((f) => {
    f.votes = votesFor(f, allVotes, players);
    f.need = f.need || 5;
    f.status = statusOf(f, f.votes, now);
    return f;
  }).sort((a, b) => b.createdAt - a.createdAt);
  return {
    players: players.map((p) => ({ id: p.id, name: p.name, removed: !!p.removed, hasPin: !!pinMap[p.id] })),
    fines,
    // Game names only. Best on ground votes and results are never sent to the public page.
    bogRounds: parseAll(bogRaw).sort((a, b) => b.createdAt - a.createdAt),
    config: { votingHours: VOTING_HOURS, votesNeeded: needFor(players), maxFine: MAX_FINE, adminEnabled: !!adminCode() },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!DB_URL || !DB_TOKEN) throw err(500, 'Database not connected yet. Add Upstash Redis to this Vercel project (see README).');
    let players = await getPlayers();
    if (req.method === 'GET') return res.status(200).json(await getState(players));
    if (req.method !== 'POST') throw err(405, 'Method not allowed');

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(b.action || ''), extra = {};
    if (action.startsWith('admin_')) await requireAdmin(b.adminPin);

    switch (action) {
      case 'login':
        extra.created = await signIn(players, b.player, b.pin, true);
        break;

      case 'create': {
        await signIn(players, b.player, b.pin, false);
        if (!activeOf(players).some((p) => p.id === b.target)) throw err(400, 'Pick who is being fined.');
        const reason = String(b.reason || '').trim().slice(0, 200);
        if (!reason) throw err(400, 'Say what they did.');
        const now = Date.now();
        const fine = {
          id: newId(''), by: b.player, target: b.target, reason, amount: cleanAmount(b.amount),
          createdAt: now, deadline: now + VOTING_HOURS * 3600 * 1000, need: needFor(players),
        };
        const cmds = [['HSET', K.fines, fine.id, JSON.stringify(fine)]];
        // The person who writes the fine automatically agrees with it.
        if (fine.by !== fine.target) cmds.push(['HSET', K.votes, fine.id + '|' + fine.by, 'yes']);
        await redis(cmds);
        break;
      }

      case 'vote': {
        await signIn(players, b.player, b.pin, false);
        if (b.vote !== 'yes' && b.vote !== 'no') throw err(400, 'Vote must be agree or disagree.');
        const fine = await getFine(b.id);
        if (fine.target === b.player) throw err(403, "You can't vote on your own fine.");
        const [votesRaw] = await redis([['HGETALL', K.votes]]);
        if (statusOf(fine, votesFor(fine, toObj(votesRaw), players), Date.now()) !== 'open') throw err(409, 'Voting on that fine has closed.');
        // HSETNX only writes if this player has no vote yet — this is the one-vote check.
        const [set] = await redis([['HSETNX', K.votes, fine.id + '|' + b.player, b.vote]]);
        if (set !== 1) throw err(409, "You've already voted on that fine.");
        break;
      }

      case 'bog_mine':
        await signIn(players, b.player, b.pin, false);
        break;

      case 'bog_vote': {
        await signIn(players, b.player, b.pin, false);
        const picks = Array.isArray(b.picks) ? b.picks.map(String) : [];
        const ids = activeOf(players).map((p) => p.id);
        if (picks.length !== 3 || picks.some((x) => !ids.includes(x))) throw err(400, 'Pick a player for 3, 2 and 1 votes.');
        if (new Set(picks).size !== 3) throw err(400, 'Pick three different players.');
        if (picks.includes(b.player)) throw err(403, "You can't vote for yourself.");
        const round = await getRound(b.id);
        if (!round.open) throw err(409, 'Voting for that game has closed.');
        const [set] = await redis([['HSETNX', K.bogVotes, round.id + '|' + b.player, JSON.stringify(picks)]]);
        if (set !== 1) throw err(409, "You've already voted for that game.");
        break;
      }

      // ---- Admin only (the admin code was checked above) ----
      case 'admin_check':
      case 'admin_bog':
        break;

      case 'admin_delete':
        await redis([['HDEL', K.fines, String(b.id)], ['HDEL', K.votes, ...players.map((p) => b.id + '|' + p.id)]]);
        break;

      case 'admin_edit_fine': {
        const fine = await getFine(b.id);
        fine.amount = cleanAmount(b.amount);
        await redis([['HSET', K.fines, fine.id, JSON.stringify(fine)]]);
        break;
      }

      case 'admin_player_add': {
        const name = cleanName(b.playerName, players);
        await savePlayer({ id: newId('p'), name, order: Math.max(-1, ...players.map((p) => p.order)) + 1 });
        break;
      }

      case 'admin_player_rename': {
        const p = findPlayer(players, b.player);
        p.name = cleanName(b.playerName, players, p.id);
        await savePlayer(p);
        break;
      }

      case 'admin_player_remove': {   // removes, or restores a removed player
        const p = findPlayer(players, b.player);
        if (p.removed) { cleanName(p.name, players, p.id); delete p.removed; }
        else p.removed = true;
        await savePlayer(p);
        break;
      }

      case 'admin_reset_pin':
        findPlayer(players, b.player);
        await redis([['HDEL', K.pins, b.player], ['DEL', K.fail + b.player]]);
        break;

      case 'admin_bog_open': {
        const name = String(b.roundName || '').trim().slice(0, 60);
        if (!name) throw err(400, 'Give the game a name, e.g. Round 5 v Tigers.');
        const round = { id: newId(''), name, open: true, createdAt: Date.now() };
        await redis([['HSET', K.bogRounds, round.id, JSON.stringify(round)]]);
        break;
      }

      case 'admin_bog_toggle': {
        const round = await getRound(b.id);
        round.open = !round.open;
        await redis([['HSET', K.bogRounds, round.id, JSON.stringify(round)]]);
        break;
      }

      case 'admin_bog_delete':
        await redis([['HDEL', K.bogRounds, String(b.id)], ['HDEL', K.bogVotes, ...players.map((p) => b.id + '|' + p.id)]]);
        break;

      case 'admin_reset_season':   // clears fines and best on ground; players and PINs stay
        await redis([['DEL', K.fines, K.votes, K.bogRounds, K.bogVotes]]);
        break;

      default:
        throw err(400, 'Unknown action.');
    }

    players = await getPlayers();
    if (['login', 'bog_mine', 'bog_vote'].includes(action)) extra.myBog = await myBog(b.player);
    if (action.startsWith('admin_')) extra.bog = await bogAdmin(players);
    return res.status(200).json({ ok: true, ...extra, state: await getState(players) });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' });
  }
};
