'use strict';

// MirCloud: group the Agents panel by fleet CATEGORY instead of by workspace.
//
// The ops1 fleet runs one lane per workspace, so upstream's grouping (one header
// per workspace) gave every lane a header of its own and a second row reading
// "Claude Code". The Operators want the lanes grouped by what they are for, in a
// fixed order, alphabetical inside each group, one line per lane:
//
//   managers  deployers  operators  builders  testers  misc
//
// The category comes from the fleet's own definition, fleet/lanes.csv: a lane's
// `function` column, except that a lane NAMED `*-manager` is a manager whatever
// its function word says (fleet-manager is a `builder` there). A workspace that is
// not a lane — an Operator's own session — is not forced into `misc`: it keeps
// upstream's behaviour and heads a group of its own, after the categories.
//
// No file found means no categories, and the panel falls back to upstream's
// workspace grouping. Nothing here writes anything.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');

const ORDER = ['managers', 'deployers', 'operators', 'builders', 'testers', 'misc'];
const BY_FUNCTION = {
  coordinator: 'managers',
  deployer: 'deployers',
  ops: 'operators',
  imager: 'operators',
  builder: 'builders',
  tester: 'testers',
};

// A workspace label is "<lane> · <tag>" (fleet/bin/gen-lanes.py).
const LABEL_SEP = ' · ';

function candidates() {
  const home = os.homedir();
  return [
    process.env.MIRCLOUD_LANES_CSV,
    config.lanesCsv,
    path.join(home, 'ops', 'fleet', 'lanes.csv'),
    path.join(home, 'ops', 'mircloud', 'fleet', 'lanes.csv'),
  ].filter(Boolean);
}

// RFC 4180 enough for lanes.csv: quoted fields may hold commas, quotes and newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function categoryFor(lane, fn) {
  if (lane.endsWith('-manager')) return 'managers';
  return BY_FUNCTION[fn] ?? 'misc';
}

// Cached on (path, mtime): the daemon asks every frame, the file changes rarely.
let cache = { file: null, mtimeMs: -1, lanes: null };

function load() {
  for (const file of candidates()) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.lanes;
    try {
      const [header, ...body] = parseCsv(fs.readFileSync(file, 'utf8'));
      const laneCol = header.indexOf('lane');
      const fnCol = header.indexOf('function');
      if (laneCol < 0 || fnCol < 0) continue;
      const lanes = new Map();
      for (const r of body) {
        const lane = (r[laneCol] ?? '').trim();
        if (lane) lanes.set(lane, categoryFor(lane, (r[fnCol] ?? '').trim()));
      }
      cache = { file, mtimeMs: stat.mtimeMs, lanes };
      return lanes;
    } catch {
      continue;
    }
  }
  cache = { file: null, mtimeMs: -1, lanes: null };
  return null;
}

function available() {
  return load() !== null;
}

// What one workspace groups under. `null` when categories are off.
//   key    the group identity the panel groups by
//   label  the header text
//   rank   the group's place in the fixed order
//   lane   the lane name, which becomes the row's title
function forLabel(workspaceId, label) {
  const lanes = load();
  if (!lanes) return null;
  const text = (label ?? '').trim();
  const lane = text.split(LABEL_SEP)[0].trim();
  const cat = lanes.get(lane);
  if (cat) return { key: `cat:${cat}`, label: cat, rank: ORDER.indexOf(cat), lane, title: text || lane };
  // Not a lane: its own group, after every category, as upstream would draw it.
  return { key: workspaceId, label: text, rank: ORDER.length, lane: text, title: text };
}

// The sort key Herdr orders the panel by in `category` mode, ascending:
// category, then lane name, then pane (splits stay together, in pane order).
function sortKey(group, pane) {
  const rank = String(group.rank).padStart(2, '0');
  return `${rank}|${group.lane.toLowerCase()}|${pane}`;
}

// MirCloud: can each lane be woken by codev mail right now? Written by the fleet's
// lane-reach.sh every 30 s. true = reachable, false = not. A file older than three
// minutes means the WRITER stopped, so every lane reads false. No file at all (an
// Operator's laptop) means no marks: null.
const REACH_MAX_AGE_S = 180;
let reachCache = { mtimeMs: -1, data: null };

function reach() {
  const file = config.reachFile ?? path.join(os.homedir(), '.local', 'state', 'mircloud', 'lane-reach.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.mtimeMs !== reachCache.mtimeMs) {
    try {
      reachCache = { mtimeMs: stat.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return null;
    }
  }
  const data = reachCache.data;
  const fresh = Date.now() / 1000 - (data.at ?? 0) <= REACH_MAX_AGE_S;
  return (lane) => (lane in (data.lanes ?? {}) ? fresh && data.lanes[lane] === true : undefined);
}

module.exports = { ORDER, available, forLabel, sortKey, parseCsv, reach };
