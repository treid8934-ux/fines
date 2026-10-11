// Fines Ladder API — one Vercel serverless function, data stored in Upstash Redis.
// No npm packages needed.
const crypto = require('crypto');

// ---- Settings you can change -------------------------------------------
const PLAYERS = ['Ayrton', 'Greg', 'Louis', 'George', 'Spencer', 'Hamish', 'Manning', 'Reid', 'Luke', 'Jack'];
const VOTING_HOURS = 48;   // fines not decided in this time lapse
const VOTES_NEEDED = 5;    // 5 of the other 9 players = majority
const MAX_FINE = 500;      // biggest single fine allowed, in dollars
// -------------------------------------------------------------------------

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const K = { pins: 'fines:pins', fines: 'fines:fines', votes: 'fines:votes', fail: 'fines:fail:', bogRounds: 'fines:bog:rounds', bogVotes: 'fines:bog:votes' };

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
  if (Number(n) >= 8) throw err(429, 'Too many wrong PINs. Try again in 10 minutes.');
}
async function recordFail(who) {
  await redis([['INCR', K.fail + who], ['EXPIRE', K.fail + who, 600]]);
}

// Checks a player's PIN. If allowCreate and they have no PIN yet, this PIN becomes theirs.
async function signIn(name, pin, allowCreate) {
  if (!PLAYERS.includes(name)) throw err(400, 'Pick your name first.');
  pin = String(pin || '');
  if (!/^\d{4}$/.test(pin)) throw err(400, 'PIN must be 4 digits.');
  await throttle(name);
  let [stored] = await redis([['HGET', K.pins, name]]);
  if (!stored) {
    if (!allowCreate) throw err(401, 'Sign in again to set your PIN.');
    const [set] = await redis([['HSETNX', K.pins, name, hashPin(pin)]]);
    if (set === 1) return true;
    [stored] = await redis([['HGET', K.pins, name]]);
  }
  if (!verifyPin(pin, stored)) { await recordFail(name); throw err(401, 'Wrong PIN for ' + name + '.'); }
  return false;
}

async function requireAdmin(pin) {
  const real = process.env.ADMIN_PIN;
  if (!real) throw err(403, 'Admin is switched off. Set ADMIN_PIN in Vercel.');
  await throttle('~admin');
  if (String(pin || '') !== String(real)) { await recordFail('~admin'); throw err(401, 'Wrong admin PIN.'); }
}

function statusOf(fine, votes, now) {
  let yes = 0, no = 0;
  for (const v of Object.values(votes)) v === 'yes' ? yes++ : no++;
  if (yes >= VOTES_NEEDED) return 'passed';
  if (no >= VOTES_NEEDED) return 'failed';
  if (now > fine.deadline) return 'lapsed';
  return 'open';
}

function parseAll(raw) {
  return Object.values(toObj(raw)).map((x) => (typeof x === 'string' ? JSON.parse(x) : x));
}

// Which best-on-ground rounds this player has already voted in.
async function myBog(name) {
  const [votes] = await redis([['HGETALL', K.bogVotes]]);
  return Object.keys(toObj(votes)).filter((k) => k.endsWith('|' + name)).map((k) => k.split('|')[0]);
}

// Admin-only view: MVP leaderboard plus who has and hasn't voted in each round.
async function bogAdmin() {
  const [roundsRaw, votesRaw] = await redis([['HGETALL', K.bogRounds], ['HGETALL', K.bogVotes]]);
  const votes = toObj(votesRaw);
  const tally = Object.fromEntries(PLAYERS.map((p) => [p, { name: p, points: 0, threes: 0, twos: 0, ones: 0 }]));
  const rounds = parseAll(roundsRaw).sort((a, b) => b.createdAt - a.createdAt).map((r) => {
    const voted = [], missing = [];
    for (const p of PLAYERS) {
      let v = votes[r.id + '|' + p];
      if (!v) { missing.push(p); continue; }
      voted.push(p);
      if (typeof v === 'string') v = JSON.parse(v);
      v.forEach((who, i) => {
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

async function getState() {
  const [pins, finesRaw, votesRaw, bogRaw] = await redis([['HGETALL', K.pins], ['HGETALL', K.fines], ['HGETALL', K.votes], ['HGETALL', K.bogRounds]]);
  const pinMap = toObj(pins), allVotes = toObj(votesRaw), now = Date.now();
  const fines = Object.values(toObj(finesRaw)).map((raw) => {
    const f = typeof raw === 'string' ? JSON.parse(raw) : raw;
    f.votes = {};
    for (const p of PLAYERS) { const v = allVotes[f.id + '|' + p]; if (v) f.votes[p] = v; }
    f.status = statusOf(f, f.votes, now);
    return f;
  }).sort((a, b) => b.createdAt - a.createdAt);
  return {
    players: PLAYERS.map((name) => ({ name, hasPin: !!pinMap[name] })),
    fines,
    // Round names only. Votes and results are never sent to the public page.
    bogRounds: parseAll(bogRaw).sort((a, b) => b.createdAt - a.createdAt),
    config: { votingHours: VOTING_HOURS, votesNeeded: VOTES_NEEDED, maxFine: MAX_FINE, adminEnabled: !!process.env.ADMIN_PIN },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!DB_URL || !DB_TOKEN) throw err(500, 'Database not connected yet. Add Upstash Redis to this Vercel project (see README).');
    if (req.method === 'GET') return res.status(200).json(await getState());
    if (req.method !== 'POST') throw err(405, 'Method not allowed');

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const extra = {};

    switch (b.action) {
      case 'login':
        extra.created = await signIn(b.name, b.pin, true);
        break;

      case 'create': {
        await signIn(b.name, b.pin, false);
        if (!PLAYERS.includes(b.target)) throw err(400, 'Pick who is being fined.');
        const reason = String(b.reason || '').trim().slice(0, 200);
        if (!reason) throw err(400, 'Say what they did.');
        const amount = Math.round(Number(b.amount) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0) throw err(400, 'Enter a dollar amount above $0.');
        if (amount > MAX_FINE) throw err(400, 'Fines are capped at $' + MAX_FINE + '.');
        const now = Date.now();
        const fine = {
          id: now.toString(36) + crypto.randomBytes(3).toString('hex'),
          by: b.name, target: b.target, reason, amount,
          createdAt: now, deadline: now + VOTING_HOURS * 3600 * 1000,
        };
        const cmds = [['HSET', K.fines, fine.id, JSON.stringify(fine)]];
        // The person who writes the fine automatically agrees with it.
        if (fine.by !== fine.target) cmds.push(['HSET', K.votes, fine.id + '|' + fine.by, 'yes']);
        await redis(cmds);
        break;
      }

      case 'vote': {
        await signIn(b.name, b.pin, false);
        if (b.vote !== 'yes' && b.vote !== 'no') throw err(400, 'Vote must be agree or disagree.');
        const [raw, votesRaw] = await redis([['HGET', K.fines, String(b.id)], ['HGETALL', K.votes]]);
        if (!raw) throw err(404, 'That fine no longer exists.');
        const fine = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (fine.target === b.name) throw err(403, "You can't vote on your own fine.");
        const all = toObj(votesRaw), votes = {};
        for (const p of PLAYERS) if (all[fine.id + '|' + p]) votes[p] = all[fine.id + '|' + p];
        if (statusOf(fine, votes, Date.now()) !== 'open') throw err(409, 'Voting on that fine has closed.');
        // HSETNX only writes if this player has no vote yet — this is the one-vote check.
        const [set] = await redis([['HSETNX', K.votes, fine.id + '|' + b.name, b.vote]]);
        if (set !== 1) throw err(409, "You've already voted on that fine.");
        break;
      }

      case 'bog_mine':
        await signIn(b.name, b.pin, false);
        break;

      case 'bog_vote': {
        await signIn(b.name, b.pin, false);
        const picks = Array.isArray(b.picks) ? b.picks.map(String) : [];
        if (picks.length !== 3 || picks.some((x) => !PLAYERS.includes(x))) throw err(400, 'Pick a player for 3, 2 and 1 votes.');
        if (new Set(picks).size !== 3) throw err(400, 'Pick three different players.');
        if (picks.includes(b.name)) throw err(403, "You can't vote for yourself.");
        const [raw] = await redis([['HGET', K.bogRounds, String(b.id)]]);
        if (!raw) throw err(404, 'That game no longer exists.');
        const round = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!round.open) throw err(409, 'Voting for that game has closed.');
        // HSETNX only writes if this player hasn't voted in this round yet.
        const [set] = await redis([['HSETNX', K.bogVotes, round.id + '|' + b.name, JSON.stringify(picks)]]);
        if (set !== 1) throw err(409, "You've already voted for that game.");
        break;
      }

      case 'admin_bog':
        await requireAdmin(b.adminPin);
        break;

      case 'admin_bog_open': {
        await requireAdmin(b.adminPin);
        const name = String(b.roundName || '').trim().slice(0, 60);
        if (!name) throw err(400, 'Give the game a name, e.g. Round 5 v Tigers.');
        const now = Date.now();
        const round = { id: now.toString(36) + crypto.randomBytes(3).toString('hex'), name, open: true, createdAt: now };
        await redis([['HSET', K.bogRounds, round.id, JSON.stringify(round)]]);
        break;
      }

      case 'admin_bog_toggle': {
        await requireAdmin(b.adminPin);
        const [raw] = await redis([['HGET', K.bogRounds, String(b.id)]]);
        if (!raw) throw err(404, 'That game no longer exists.');
        const round = typeof raw === 'string' ? JSON.parse(raw) : raw;
        round.open = !round.open;
        await redis([['HSET', K.bogRounds, round.id, JSON.stringify(round)]]);
        break;
      }

      case 'admin_bog_delete':
        await requireAdmin(b.adminPin);
        await redis([['HDEL', K.bogRounds, String(b.id)], ['HDEL', K.bogVotes, ...PLAYERS.map((p) => b.id + '|' + p)]]);
        break;

      case 'admin_check':
        await requireAdmin(b.adminPin);
        break;

      case 'admin_delete':
        await requireAdmin(b.adminPin);
        await redis([['HDEL', K.fines, String(b.id)], ['HDEL', K.votes, ...PLAYERS.map((p) => b.id + '|' + p)]]);
        break;

      case 'admin_reset_pin':
        await requireAdmin(b.adminPin);
        if (!PLAYERS.includes(b.player)) throw err(400, 'Pick a player.');
        await redis([['HDEL', K.pins, b.player], ['DEL', K.fail + b.player]]);
        break;

      case 'admin_reset_season':
        await requireAdmin(b.adminPin);
        await redis([['DEL', K.fines, K.votes, K.bogRounds, K.bogVotes]]);
        break;

      default:
        throw err(400, 'Unknown action.');
    }
    if (['login', 'bog_mine', 'bog_vote'].includes(b.action)) extra.myBog = await myBog(b.name);
    if (b.action.startsWith('admin_')) extra.bog = await bogAdmin();
    return res.status(200).json({ ok: true, ...extra, state: await getState() });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' });
  }
};
