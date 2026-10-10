/* ────────────────────────────────────────────────────────────────────────────
   api.js — replaces Google Apps Script + Google Sheets with Supabase.

   The page was written against `google.script.run.<function>()`. This file
   provides the same object, with the same function names and the same return
   shapes (ported from Code.gs), but the data now lives in Supabase tables
   (see supabase/002_parliament.sql). Who may do what is decided by the
   database from the login token, not by anything this file (or the browser)
   claims.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CFG = window.PARL_CONFIG || {};
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.insertAdjacentHTML('afterbegin',
        '<div style="background:#B22222;color:#fff;padding:12px;text-align:center">config.js is missing SUPABASE_URL / SUPABASE_ANON_KEY</div>');
    });
    return;
  }

  /* ── login token (sent to the database on every request) ── */
  var TOKEN_KEY = '_parl_token';
  var token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
  function setToken(t) {
    token = t || '';
    try { if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: function (url, opts) {
        opts = opts || {};
        var h = new Headers(opts.headers || {});
        if (token) h.set('x-app-token', token);
        return fetch(url, Object.assign({}, opts, { headers: h }));
      }
    }
  });
  window.__parlSb = sb;                       // used by import.html

  /* ── helpers ── */
  var T = function (v) { return String(v == null ? '' : v).trim(); };
  var DENIED = { ok: false, msg: 'ไม่มีสิทธิ์ หรือเซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' };

  var cache = new Map();
  function cached(key, ttlMs, fn) {
    var hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    var p = fn();
    cache.set(key, { exp: Date.now() + ttlMs, p: p });
    p.catch(function () { cache.delete(key); });
    return p;
  }
  function bust() { cache.clear(); }

  /* read a whole table (PostgREST returns at most 1000 rows per request) */
  async function all(table, cols, mod) {
    var out = [];
    for (var from = 0; ; from += 1000) {
      var q = sb.from(table).select(cols || '*').order('id', { ascending: true }).range(from, from + 999);
      if (mod) q = mod(q);
      var res = await q;
      if (res.error) throw res.error;
      out = out.concat(res.data);
      if (res.data.length < 1000) break;
    }
    return out;
  }

  /* DB rows → arrays in the old sheet column order, so the ported logic below
     can keep using the original r[0], r[1] … indexes. */
  var asLaw   = function (x) { return [x.name, x.type, x.link, x.date, x.status, x.a_name, x.a_link, x.a_date, x.a_status]; };
  var asVote  = function (x) { return [x.law_name, x.stage, x.bill_side, x.draft_link, x.pronoun_introducer, x.introducer, x.pronoun_voter, x.voter_name, x.vote, x.member_pos, x.voter_side, x.date]; };
  var asMem   = function (x) { return [x.pronoun, x.name, x.position, x.party, x.mp_type, x.in_office, x.out_of_office, x.picture, x.party_color]; };
  var asCab   = function (x) { return [x.ministry, x.pronoun, x.name, x.position, x.party, x.in_office, x.out_of_office, x.picture, x.party_color]; };
  var asQ     = function (x) { return [x.pronoun_asker, x.ask_name, x.a_role, x.a_ministry, x.pronoun_who, x.to_who, x.position, x.ministry, x.topic, x.stories, x.date, x.answer, x.a_date]; };
  var asAg    = function (x) { return [x.date, x.number, x.session, x.chamber, x.stage, x.topic, x.pronoun_introducer, x.introducer, x.side, x.links]; };
  var asHs    = function (x) { return [x.date, x.number, x.session, x.chamber, x.pronoun, x.name, x.role, x.agenda_ref, x.agenda_stage, x.speech_text, x.ts]; };

  var loadLaw     = function () { return cached('law', 30000, function () { return all('parl_law').then(function (r) { return r.map(function (x) { return asLaw(x); }); }); }); };
  var loadMembers = function () { return cached('members', 30000, function () { return all('parl_members').then(function (r) { return r.map(function (x) { var a = asMem(x); a.id = x.id; return a; }); }); }); };
  var loadCabinet = function (shadow) { return cached('cab' + shadow, 30000, function () { return all('parl_cabinet', '*', function (q) { return q.eq('is_shadow', !!shadow); }).then(function (r) { return r.map(function (x) { var a = asCab(x); a.id = x.id; return a; }); }); }); };
  var loadQuestions = function () { return cached('q', 15000, function () { return all('parl_questions').then(function (r) { return r.map(function (x) { var a = asQ(x); a.id = x.id; return a; }); }); }); };
  /* votes: only the columns each caller needs */
  var loadVotesLite = function () {
    return cached('votesLite', 30000, function () {
      return all('parl_votes', 'sheet,law_name,stage,bill_side,introducer,voter_name,voter_side,date').then(function (r) { return r; });
    });
  };

  /* dates are stored like the sheet had them: dd/MM/yyyy, year in Buddhist or Gregorian era */
  function dateVal(str) {
    var p = String(str || '').split('/');
    if (p.length !== 3) return 0;
    var y = parseInt(p[2], 10); if (y > 2500) y -= 543;
    var t = Date.UTC(y, parseInt(p[1], 10) - 1, parseInt(p[0], 10));
    return isNaN(t) ? 0 : t;
  }
  function parseDate(str) {                    // _parseDate in Code.gs
    if (!str || str === 'undefined') return null;
    var p = String(str).split('/');
    if (p.length === 3) {
      var y = parseInt(p[2], 10) > 2500 ? parseInt(p[2], 10) - 543 : parseInt(p[2], 10);
      return new Date(y, parseInt(p[1], 10) - 1, parseInt(p[0], 10));
    }
    return null;
  }
  function fmtDate(d) {
    var z = function (n) { return String(n).padStart(2, '0'); };
    return z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear();
  }
  var PREFIXES = ['นาย', 'นาง', 'นางสาว', 'ดร.', 'ศาสตราจารย์', 'รองศาสตราจารย์', 'ผู้ช่วยศาสตราจารย์'];

  async function pronounLookup() {
    var rows = await loadMembers(), m = {};
    rows.forEach(function (r) { var n = T(r[1]); if (n && !m[n]) m[n] = T(r[0]); });
    return function (raw) {
      if (!raw || !String(raw).trim()) return { pronoun: '', name: '' };
      var clean = String(raw).trim();
      for (var i = 0; i < PREFIXES.length; i++) {
        if (clean.indexOf(PREFIXES[i] + ' ') === 0) { clean = clean.substring(PREFIXES[i].length).trim(); break; }
      }
      return { pronoun: m[clean] || '', name: clean };
    };
  }

  function isErr(e) { return e && (e.code || e.message); }
  /* wrap an admin write: database errors (not signed in as admin, etc.) become {ok:false,msg} */
  async function guard(fn) {
    try { var r = await fn(); bust(); return r; }
    catch (e) {
      if (e && (e.code === '42501' || /row-level security|permission denied/i.test(e.message || ''))) return DENIED;
      console.error(e); return { ok: false, msg: 'เกิดข้อผิดพลาด: ' + ((e && e.message) || e) };
    }
  }
  function must(res) { if (res.error) throw res.error; return res.data; }
  /* update/delete that matches nothing visible = not allowed (row-level security hides it) */
  function mustTouch(res) { var d = must(res); if (!d || !d.length) throw { code: '42501' }; return d; }

  /* ── 1. DATA READERS (ported from Code.gs) ───────────────────────────────── */
  var API = {};

  API.getFastData = async function () {
    var r = await Promise.all([API.getPetitionData(), API.getListNames('VoteRecords'), API.getListNames('Committee'),
                               API.getQuestionData(), API.getAllMemberSides(), API.getAgendaData()]);
    return { petitions: r[0], voteNames: r[1], committeeNames: r[2], questions: r[3], memberSides: r[4], agendas: r[5] };
  };
  API.getSlowData = async function () {
    var r = await Promise.all([API.getLawData(), API.getMemberData(), API.getCabinetData(), API.getShadowCabinetData()]);
    return { laws: r[0], members: r[1], cabinet: r[2], shadowCab: r[3] };
  };
  API.getAllInitialData = async function () { return Object.assign({}, await API.getFastData(), await API.getSlowData()); };

  API.getLawData = async function () {
    var data = await loadLaw(), groups = {}, order = [];
    data.forEach(function (r) {
      var mainName = T(r[0]); if (!mainName) return;
      if (!groups[mainName]) {
        groups[mainName] = { name: mainName, type: String(r[1]), link: (r[2] && T(r[2]) !== '') ? r[2] : null,
                             date: r[3], status: String(r[4]), amendments: [] };
        order.push(mainName);
      }
      if (r[5] && T(r[5]) !== '' && String(r[5]).toUpperCase() !== 'TEST') {
        groups[mainName].amendments.push({ aName: String(r[5]), aLink: (r[6] && T(r[6]) !== '') ? r[6] : null, aDate: r[7], aStatus: String(r[8] || '') });
      }
    });
    return order.map(function (k) { return groups[k]; });
  };

  API.getPetitionData = async function () {
    var rows = await cached('pet', 15000, function () {
      return all('parl_petitions', 'id,name,type,link,cur,goal,status,pronoun,presenter,approval', function (q) { return q.eq('approval', 'Approved'); });
    });
    return rows.filter(function (r) { return r.name; }).map(function (r) {
      var cur = Number(r.cur) || 0, goal = Number(r.goal) || 0;
      return { name: r.name, type: r.type, link: r.link, cur: cur, goal: goal,
               status: (cur >= goal) ? 'ปิดให้ลงชื่อเสนอ' : r.status, pronoun: T(r.pronoun), user: T(r.presenter) };
    });
  };
  API.getWaitingPetitions = async function () { var d = must(await sb.rpc('parl_admin_waiting_petitions')); return d || []; };
  API.adminUpdatePetition = function (rowIndex, action) {
    return guard(async function () {
      var id = Number(rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      mustTouch(await sb.from('parl_petitions').update({ approval: action === 'approve' ? 'Approved' : 'Rejected' }).eq('id', id).select('id'));
      return { ok: true };
    });
  };
  API.handleSignature = async function (lawName) {
    var r = must(await sb.rpc('parl_sign_petition', { p_name: lawName }));
    bust(); return r;
  };
  API.submitNew = async function (p) {
    var r = must(await sb.rpc('parl_submit_petition', { p: { title: p.title, type: p.type, link: p.link } }));
    bust(); return r;
  };

  API.getListNames = async function (sheetName) {
    var rows = await loadVotesLite(), latest = new Map();
    rows.forEach(function (r) {
      if (r.sheet !== sheetName) return;
      var name = T(r.law_name); if (!name) return;
      var d = r.date || '';
      if (!latest.has(name) || dateVal(d) > dateVal(latest.get(name))) latest.set(name, d);
    });
    var names = Array.from(latest.keys());
    names.sort(function (a, b) { return dateVal(latest.get(b)) - dateVal(latest.get(a)); });
    return names;
  };

  API.getAllMemberSides = async function () {
    var rows = await loadVotesLite(), ld = {}, ls = {};
    rows.forEach(function (r) {
      if (r.sheet !== 'VoteRecords') return;
      var name = T(r.voter_name), side = T(r.voter_side); if (!name || !side) return;
      var d = dateVal(r.date);
      if (ld[name] === undefined || d > ld[name]) { ld[name] = d; ls[name] = side; }
    });
    return ls;
  };

  API.getMemberData = async function () {
    var data = await loadMembers(), groups = {}, order = [];
    data.forEach(function (r) {
      var pronoun = T(r[0]), name = T(r[1]); if (!name) return;
      if (!groups[name]) {
        groups[name] = { pronoun: pronoun, name: name, position: T(r[2]), party: T(r[3]), mpType: T(r[4]),
          inOffice: T(r[5]), outOfOffice: T(r[6]), picture: T(r[7]), partyColor: T(r[8]), additionalRoles: [] };
        order.push(name);
      } else if (r[2] && T(r[2])) {
        groups[name].additionalRoles.push({ role: T(r[2]), party: T(r[3]), mpType: T(r[4]), partyColor: T(r[8]), inOffice: T(r[5]), outOfOffice: T(r[6]) });
      }
    });
    return order.map(function (k) { return groups[k]; });
  };

  async function memberLookupMap() {
    var data = await loadMembers(), lookup = {};
    data.forEach(function (r) {
      var name = T(r[1]); if (!name || lookup[name]) return;
      var picture = T(r[7]), partyColor = T(r[8]);
      lookup[name] = { picture: (picture && picture !== 'undefined') ? picture : '', partyColor: (partyColor && partyColor !== 'undefined') ? partyColor : '' };
    });
    return lookup;
  }
  API.getMemberRawRows = async function (name) {
    var data = await loadMembers(), res = [];
    data.forEach(function (r) {
      if (T(r[1]) === T(name)) res.push({ rowIndex: r.id, pronoun: T(r[0]), name: T(r[1]), position: T(r[2]), party: T(r[3]),
        mpType: T(r[4]), inOffice: T(r[5]), outOfOffice: T(r[6]), picture: T(r[7]), partyColor: T(r[8]) });
    });
    return res;
  };
  API.getIncumbentMembersForVoting = async function () {
    var data = await loadMembers(), res = [], seen = new Set();
    var VALID = ['สมาชิกสภาผู้แทนราษฎร', 'สมาชิกวุฒิสภา', 'สมาชิกสมัชชาแห่งชาติ'];
    var curName = '', curPronoun = '';
    data.forEach(function (r) {
      var pronoun = T(r[0]), nameCell = T(r[1]), position = T(r[2]), party = T(r[3]), mpType = T(r[4]),
          outOff = T(r[6]), picture = T(r[7]), partyColor = T(r[8]);
      if (nameCell) { curName = nameCell; curPronoun = pronoun; }
      var name = curName;
      if (!name || !position) return;
      if (outOff && outOff !== 'undefined') return;
      if (VALID.indexOf(position) < 0) return;
      var key = name + '|' + position; if (seen.has(key)) return; seen.add(key);
      res.push({ name: name, pronoun: curPronoun, position: position, party: party, mpType: mpType,
        picture: (picture && picture !== 'undefined') ? picture : '', partyColor: (partyColor && partyColor !== 'undefined') ? partyColor : '#999',
        roleLabel: position + (party && party !== 'อิสระ' ? ' ' + party : ' อิสระ') });
    });
    return res;
  };

  function voteColor(t) {
    if (t.indexOf('ไม่เห็นชอบ') >= 0) return '#B22222';
    if (t.indexOf('เห็นชอบ') >= 0) return '#2E7D32';
    if (t.indexOf('งดออกเสียง') >= 0) return '#FBC02D';
    if (t.indexOf('ไม่ลงคะแนน') >= 0) return '#9e9e9e';
    return '#666';
  }

  API.getHistoryData = async function (sheetName, itemName) {
    var rows = (await all('parl_votes', '*', function (q) { return q.eq('sheet', sheetName).eq('law_name', T(itemName)); })).map(asVote);
    var res = {};
    rows.forEach(function (r) {
      var s = String(r[1]);
      if (!res[s]) res[s] = { link: r[3], introducers: [], billSide: T(r[2]), logs: [], date: String(r[11] || ''), summary: { yes: 0, no: 0, abst: 0, none: 0 } };
      var billSide = T(r[2]), draftLink = T(r[3]), introducerRaw = T(r[5]), pronounVoter = T(r[6]), voterName = T(r[7]),
          t = T(r[8]), memberPos = T(r[9]), voterSide = T(r[10]), dv = String(r[11] || '');
      if (!res[s].date && dv) res[s].date = dv;
      if (!res[s].link && draftLink) res[s].link = draftLink;
      res[s].billSide = billSide;
      if (introducerRaw) introducerRaw.split(',').map(T).filter(Boolean).forEach(function (n) { if (res[s].introducers.indexOf(n) < 0) res[s].introducers.push(n); });
      var c = voteColor(t);
      if (t.indexOf('ไม่เห็นชอบ') >= 0) res[s].summary.no++;
      else if (t.indexOf('เห็นชอบ') >= 0) res[s].summary.yes++;
      else if (t.indexOf('งดออกเสียง') >= 0) res[s].summary.abst++;
      else if (t.indexOf('ไม่ลงคะแนน') >= 0) res[s].summary.none++;
      res[s].logs.push({ v: voterName, pronoun: pronounVoter, r: memberPos, t: t, c: c, side: voterSide });
    });
    Object.keys(res).forEach(function (s) { res[s].introducer = res[s].introducers[0] || ''; });
    return res;
  };

  API.getMemberVotes = async function (memberName) {
    var rows = await all('parl_votes', '*', function (q) { return q.eq('voter_name', T(memberName)); });
    rows.sort(function (a, b) { return (a.sheet === b.sheet ? 0 : a.sheet === 'VoteRecords' ? -1 : 1) || (a.id - b.id); });
    return rows.map(function (x) {
      var r = asVote(x), vote = String(r[8] || ''), introducerRaw = T(r[5]);
      return { lawName: String(r[0]), stage: String(r[1]), billSide: T(r[2]),
        introducers: introducerRaw.split(',').map(T).filter(Boolean), introducer: introducerRaw.split(',')[0].trim(),
        voterSide: T(r[10]), vote: vote, color: voteColor(vote), date: String(r[11] || '') };
    });
  };

  API.getQuestionData = async function () {
    var data = await loadQuestions();
    return data.map(function (r) {
      return { _rowIndex: r.id, pronounAsker: T(r[0]), askName: T(r[1]), aRole: T(r[2]), aMinistry: T(r[3]), pronounWho: T(r[4]),
        toWho: T(r[5]), position: T(r[6]), ministry: T(r[7]), topic: T(r[8]), stories: T(r[9]), date: T(r[10]), answer: T(r[11]), aDate: T(r[12]) };
    }).filter(function (r) { return r.askName !== ''; });
  };

  API.getIncumbentCabinetForQuestion = async function () {
    var data = await loadCabinet(false), seen = new Set(), res = [];
    data.forEach(function (r) {
      var ministry = T(r[0]), name = T(r[2]), position = T(r[3]), outOff = T(r[6]);
      if (!ministry || !name || !position) return;
      if (outOff && outOff !== 'undefined') return;
      var key = name + '|' + position; if (seen.has(key)) return; seen.add(key);
      res.push({ name: name, position: position, ministry: ministry });
    });
    return res;
  };

  /* cabinet building (verbatim logic from Code.gs) */
  function buildCabinetMinistry(members, POSITION_ORDER, ministryName, isShadow) {
    var ministryStart = null;
    members.forEach(function (m) { var d = parseDate(m.inOff); if (d && (!ministryStart || d < ministryStart)) ministryStart = d; });
    var ministryEndDate = null, ministryActive = false;
    members.forEach(function (m) {
      var out = m.outOff ? m.outOff.trim() : '';
      if (!out || out === 'undefined') ministryActive = true;
      else { var d = parseDate(out); if (d && (!ministryEndDate || d > ministryEndDate)) ministryEndDate = d; }
    });
    if (ministryActive) ministryEndDate = null;

    var memberRoles = {}, mrOrder = [];
    members.forEach(function (m) {
      if (!memberRoles[m.name]) { memberRoles[m.name] = { name: m.name, pronoun: m.pronoun, positions: [], inOffs: [], outOffs: [], picture: m.picture, partyColor: m.partyColor, party: m.party }; mrOrder.push(m.name); }
      memberRoles[m.name].positions.push(m.position); memberRoles[m.name].inOffs.push(m.inOff); memberRoles[m.name].outOffs.push(m.outOff);
    });
    var ordIdx = function (pos) { var i = POSITION_ORDER.indexOf(pos); return i === -1 ? 99 : i; };
    var coreMap = {}, coreOrder = [], reshuffled = [];

    mrOrder.forEach(function (nm) {
      var mr = memberRoles[nm], inc = [], oust = [];
      mr.positions.forEach(function (pos, idx) {
        var out = mr.outOffs[idx] ? mr.outOffs[idx].trim() : '';
        var isInc = !out || out === 'undefined';
        var item = { position: pos, inOff: mr.inOffs[idx], outOff: mr.outOffs[idx] };
        if (ministryActive) { (isInc ? inc : oust).push(item); }
        else if (isInc) inc.push(item);
        else {
          var memberEnd = parseDate(out);
          var diffDays = ministryEndDate ? Math.abs((memberEnd - ministryEndDate) / 86400000) : 999;
          (diffDays <= 3 ? inc : oust).push(item);
        }
      });
      var byInOff = function (a, b) { return (parseDate(a) || new Date(0)) - (parseDate(b) || new Date(0)); };
      if (inc.length > 0) {
        inc.sort(function (a, b) { return ordIdx(a.position) - ordIdx(b.position); });
        var primary = inc[0], key = primary.position + '|' + mr.name;
        if (!coreMap[key]) coreOrder.push(key);
        coreMap[key] = { name: mr.name, pronoun: mr.pronoun, position: primary.position,
          extraPositions: inc.slice(1).map(function (p) { return p.position; }), oustedPositions: oust,
          inOff: mr.inOffs.slice().sort(byInOff)[0], outOff: primary.outOff, party: mr.party, picture: mr.picture, partyColor: mr.partyColor };
      } else if (oust.length > 0) {
        oust.sort(function (a, b) { return ordIdx(a.position) - ordIdx(b.position); });
        var pr = oust[0];
        reshuffled.push({ name: mr.name, pronoun: mr.pronoun, position: pr.position,
          extraPositions: oust.slice(1).map(function (p) { return p.position; }), oustedPositions: [],
          inOff: oust.map(function (p) { return p.inOff; }).sort(byInOff)[0], outOff: pr.outOff,
          party: mr.party, picture: mr.picture, partyColor: mr.partyColor });
      }
    });
    var coreMembers = coreOrder.map(function (k) { return coreMap[k]; }).sort(function (a, b) { return ordIdx(a.position) - ordIdx(b.position); });
    reshuffled.sort(function (a, b) { return (parseDate(b.outOff) || new Date(0)) - (parseDate(a.outOff) || new Date(0)); });
    return { ministryName: ministryName, active: ministryActive, isShadow: !!isShadow,
      ministryStart: ministryStart ? fmtDate(ministryStart) : '', ministryEnd: ministryEndDate ? fmtDate(ministryEndDate) : '',
      coreMembers: coreMembers, reshuffledMembers: reshuffled };
  }

  var POSITION_ORDER = ['นายกรัฐมนตรี', 'รักษาการนายกรัฐมนตรี', 'รองนายกรัฐมนตรี', 'รัฐมนตรีประจำสำนักนายกรัฐมนตรี',
    'รัฐมนตรีว่าการกระทรวงกลาโหม', 'รัฐมนตรีว่าการกระทรวงการต่างประเทศ', 'รัฐมนตรีว่าการกระทรวงมหาดไทย', 'รัฐมนตรีว่าการกระทรวงยุติธรรม',
    'รัฐมนตรีว่าการกระทรวงเศรษฐกิจและการคลัง', 'รัฐมนตรีว่าการกระทรวงองค์การแห่งรัฐ โทรคมนาคม และกิจการเอกชน',
    'รัฐมนตรีว่าการกระทรวงสาธารณสุข', 'รัฐมนตรีว่าการกระทรวงอุดมศึกษา วิทยาศาสตร์ วิจัยและนวัตกรรม',
    'รัฐมนตรีช่วยว่าการกระทรวงกลาโหม', 'รัฐมนตรีช่วยว่าการกระทรวงการต่างประเทศ', 'รัฐมนตรีช่วยว่าการกระทรวงมหาดไทย', 'รัฐมนตรีช่วยว่าการกระทรวงยุติธรรม',
    'รัฐมนตรีช่วยว่าการกระทรวงเศรษฐกิจและการคลัง', 'รัฐมนตรีช่วยว่าการกระทรวงองค์การแห่งรัฐ โทรคมนาคม และกิจการเอกชน',
    'รัฐมนตรีช่วยว่าการกระทรวงสาธารณสุข', 'รัฐมนตรีช่วยว่าการกระทรวงอุดมศึกษา วิทยาศาสตร์ วิจัยและนวัตกรรม'];
  var SHADOW_POSITION_ORDER = ['ผู้นำฝ่ายค้านในสภาผู้แทนราษฎร', 'รองผู้นำฝ่ายค้านในสภาผู้แทนราษฎร', 'รัฐมนตรีฝ่ายค้านประจำสำนักนายกรัฐมนตรี',
    'รัฐมนตรีฝ่ายค้านว่าการกระทรวงกลาโหม', 'รัฐมนตรีฝ่ายค้านว่าการกระทรวงการต่างประเทศ', 'รัฐมนตรีฝ่ายค้านว่าการกระทรวงมหาดไทย',
    'รัฐมนตรีฝ่ายค้านว่าการกระทรวงยุติธรรม', 'รัฐมนตรีฝ่ายค้านว่าการกระทรวงเศรษฐกิจและการคลัง',
    'รัฐมนตรีฝ่ายค้านว่าการกระทรวงองค์การแห่งรัฐ โทรคมนาคม และกิจการเอกชน', 'รัฐมนตรีฝ่ายค้านว่าการกระทรวงสาธารณสุข',
    'รัฐมนตรีฝ่ายค้านว่าการกระทรวงอุดมศึกษา วิทยาศาสตร์ วิจัยและนวัตกรรม',
    'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงกลาโหม', 'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงการต่างประเทศ', 'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงมหาดไทย',
    'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงยุติธรรม', 'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงเศรษฐกิจและการคลัง',
    'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงองค์การแห่งรัฐ โทรคมนาคม และกิจการเอกชน', 'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงสาธารณสุข',
    'รัฐมนตรีฝ่ายค้านช่วยว่าการกระทรวงอุดมศึกษา วิทยาศาสตร์ วิจัยและนวัตกรรม'];

  async function cabinetData(shadow) {
    var ml = await memberLookupMap(), data = await loadCabinet(shadow), by = {}, order = [];
    data.forEach(function (r) {
      var ministry = T(r[0]), pronoun = T(r[1]), name = T(r[2]), position = T(r[3]);
      if (!ministry || !name || !position) return;
      var m = ml[name] || {};
      if (!by[ministry]) { by[ministry] = []; order.push(ministry); }
      by[ministry].push({ pronoun: pronoun, name: name, position: position, party: T(r[4]), inOff: T(r[5]), outOff: T(r[6]),
        picture: m.picture || T(r[7]), partyColor: m.partyColor || T(r[8]) });
    });
    var result = order.map(function (mn) { return buildCabinetMinistry(by[mn], shadow ? SHADOW_POSITION_ORDER : POSITION_ORDER, mn, shadow); });
    result.sort(function (a, b) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (parseDate(b.ministryStart) || new Date(0)) - (parseDate(a.ministryStart) || new Date(0));
    });
    return result;
  }
  API.getCabinetData = function () { return cached('cabData', 30000, function () { return cabinetData(false); }); };
  API.getShadowCabinetData = function () { return cached('shadowData', 30000, function () { return cabinetData(true); }); };

  API.getCabinetExtras = function () {
    return cached('cabExtras', 30000, async function () {
      var votes = await loadVotesLite(), qData = (await loadQuestions());
      var cab = await API.getCabinetData(), shadow = await API.getShadowCabinetData();
      var rawCab = await loadCabinet(false), rawShadow = await loadCabinet(true);
      var PASSED = 'ประกาศในราชกิจจานุเบกษา บังคับใช้เป็นกฎหมาย';
      var shadowMinistryByName = {};
      rawShadow.forEach(function (r) {
        var m = T(r[0]), n = T(r[2]), o = T(r[6]);
        if (!m || !n) return; if (o && o !== 'undefined') return;
        if (!shadowMinistryByName[n]) shadowMinistryByName[n] = m;
      });
      var matchMin = function (introRaw, mn) {
        return introRaw.split(',').map(T).filter(Boolean).some(function (i) { return i === mn || i.indexOf(mn) >= 0 || mn.indexOf(i) >= 0; });
      };
      var computeStats = function (names, ministryName, isShadow) {
        var stats = {};
        names.forEach(function (n) { stats[n] = { questionsAnswered: 0, questionsAsked: 0, billsIntroduced: 0, billsPassed: 0 }; });
        if (qData.length > 0 && ministryName) {
          var mn = T(ministryName);
          qData.forEach(function (r) {
            var askName = T(r[1]), aMin = T(r[3]), answerer = T(r[5]), ansMin = T(r[7]), answer = T(r[11]);
            if (isShadow) {
              var eff = aMin || shadowMinistryByName[askName] || '';
              if (eff === mn && askName && stats[askName] !== undefined) stats[askName].questionsAsked++;
            } else if (ansMin === mn && answer !== '' && stats[answerer] !== undefined) stats[answerer].questionsAnswered++;
          });
        }
        if (ministryName) {
          var mn2 = T(ministryName);
          votes.forEach(function (r) {
            var introRaw = T(r.introducer), isPassed = T(r.stage) === PASSED;
            if (!introRaw) return;
            if (!matchMin(introRaw, mn2)) return;
            names.forEach(function (name) { if (stats[name] !== undefined) { stats[name].billsIntroduced++; if (isPassed) stats[name].billsPassed++; } });
          });
        }
        return stats;
      };
      var uniq = function (arr) { return arr.filter(function (n, i, a) { return n && a.indexOf(n) === i; }); };
      var result = { cabinet: {}, shadow: {} };
      cab.forEach(function (c, idx) { var names = uniq(c.coreMembers.concat(c.reshuffledMembers).map(function (m) { return m.name; })); if (names.length) result.cabinet[idx] = computeStats(names, c.ministryName, false); });
      shadow.forEach(function (c, idx) { var names = uniq(c.coreMembers.concat(c.reshuffledMembers).map(function (m) { return m.name; })); if (names.length) result.shadow[idx] = computeStats(names, c.ministryName, true); });

      /* bills per ministry */
      var bills = {}, mins = new Set();
      rawCab.concat(rawShadow).forEach(function (r) { var mn = T(r[0]); if (mn) mins.add(mn); });
      mins.forEach(function (mn) { bills[mn] = {}; });
      votes.forEach(function (r) {
        var lawName = T(r.law_name), introRaw = T(r.introducer), billSide = T(r.bill_side), isPassed = T(r.stage) === PASSED;
        if (!lawName || !introRaw) return;
        mins.forEach(function (mn) {
          if (!matchMin(introRaw, mn)) return;
          var key = r.sheet + '|' + lawName;
          if (!bills[mn][key]) bills[mn][key] = { lawName: lawName, billSide: billSide, sheet: r.sheet, isPassed: false };
          if (isPassed) bills[mn][key].isPassed = true;
        });
      });
      mins.forEach(function (mn) {
        bills[mn] = Object.keys(bills[mn]).map(function (k) { return bills[mn][k]; }).sort(function (a, b) {
          if (a.sheet !== b.sheet) return a.sheet === 'VoteRecords' ? -1 : 1;
          return a.lawName.localeCompare(b.lawName, 'th');
        });
      });
      return { stats: result, bills: bills };
    });
  };
  API.getAllCabinetStats = async function () { return (await API.getCabinetExtras()).stats; };
  API.getAllCabinetBills = async function () { return (await API.getCabinetExtras()).bills; };

  /* agenda */
  var AGENDA_SECTION_LABEL = { 0: '(เรื่องด่วน)', 1: '(1) เรื่องที่ประธานแจ้งต่อที่ประชุม', 2: '(2) รับรองรายงานการประชุม', 3: '(3) เรื่องที่เสนอใหม่',
    4: '(4) เรื่องที่คณะกรรมาธิการพิจารณาเสร็จแล้ว', 5: '(5) เรื่องที่ค้างพิจารณา', 6: '(6) กระทู้ถาม', 7: '(7) เรื่องอื่น ๆ' };

  API.getAgendaData = function () {
    return cached('agenda', 15000, async function () {
      var rows = await all('parl_agendas'), map = {}, order = [], labelToSection = {};
      Object.keys(AGENDA_SECTION_LABEL).forEach(function (n) { labelToSection[AGENDA_SECTION_LABEL[n]] = Number(n); });
      rows.forEach(function (x) {
        var r = asAg(x), dateStr = T(r[0]), number = T(r[1]), session = T(r[2]), chamber = T(r[3]), eCol = T(r[4]), topic = T(r[5]),
            intro = T(r[7]), side = T(r[8]), url = T(r[9]);
        if (!dateStr) return;
        var key = dateStr + '|' + number + '|' + session;
        if (!map[key]) { map[key] = { _key: key, date: dateStr, number: number, session: session, chamber: chamber, note: '', items: [] }; order.push(key); }
        var ag = map[key];
        if (!topic) {
          if (eCol.indexOf('footnote:') === 0) { if (!ag.footnotes) ag.footnotes = []; ag.footnotes.push(eCol.replace('footnote:', '').trim()); }
          else if (eCol && !ag.note) ag.note = eCol;
          return;
        }
        var sectionNum = labelToSection[eCol] !== undefined ? labelToSection[eCol] : -1;
        var isUrgent = eCol === AGENDA_SECTION_LABEL[0] || sectionNum === 0;
        ag.items.push({ _rowIndex: x.id, section: sectionNum >= 0 ? sectionNum : eCol, sectionLabel: eCol,
          type: isUrgent ? 'urgent' : (intro ? 'bill' : 'plain'), text: topic, introducer: intro, side: side, url: url });
      });
      return order.reverse().map(function (k) { return map[k]; });
    });
  };

  /* hansard */
  function hansardTs(ts) {
    if (!ts) return 0;
    var s = String(ts).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var parts = s.split(':').map(Number);
    if (parts.length >= 2 && parts.every(function (n) { return !isNaN(n); })) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    return 0;
  }
  function resolveVote(votesByLaw, lawName, stage) {
    var all_ = votesByLaw[T(lawName)] || [];
    var rows = all_.filter(function (r) { return r.sheet === 'VoteRecords' && T(r.stage) === T(stage); }), sheetUsed = 'VoteRecords';
    if (!rows.length) { rows = all_.filter(function (r) { return r.sheet === 'Committee' && T(r.stage) === T(stage); }); sheetUsed = 'Committee'; }
    if (!rows.length) return { found: false, lawName: lawName, stage: stage };
    var summary = { yes: 0, no: 0, abst: 0, none: 0 }, logs = [], link = '', billSide = '', dv = '', introducers = [];
    rows.forEach(function (x) {
      var r = asVote(x), rBillSide = T(r[2]), rLink = T(r[3]), rIntro = T(r[5]), pv = T(r[6]), vn = T(r[7]), t = T(r[8]), mp = T(r[9]), vs = T(r[10]), rd = String(r[11] || '');
      if (!dv && rd) dv = rd; if (!link && rLink) link = rLink; if (!billSide && rBillSide) billSide = rBillSide;
      if (rIntro) rIntro.split(',').map(T).filter(Boolean).forEach(function (n) { if (introducers.indexOf(n) < 0) introducers.push(n); });
      if (!vn || !t) return;
      var c = voteColor(t);
      if (t.indexOf('ไม่เห็นชอบ') >= 0) summary.no++; else if (t.indexOf('เห็นชอบ') >= 0) summary.yes++;
      else if (t.indexOf('งดออกเสียง') >= 0) summary.abst++; else if (t.indexOf('ไม่ลงคะแนน') >= 0) summary.none++;
      logs.push({ v: vn, pronoun: pv, r: mp, t: t, c: c, side: vs });
    });
    return { found: true, lawName: lawName, stage: stage, sheet: sheetUsed, link: link, billSide: billSide, date: dv,
             introducers: introducers, summary: summary, logs: logs, stagePassed: summary.yes > summary.no };
  }
  API.getHansardData = function () {
    return cached('hansard', 15000, async function () {
      var rows = await all('parl_hansard'), map = {}, order = [];
      var refs = Array.from(new Set(rows.filter(function (x) { return !T(x.name) && !T(x.speech_text) && T(x.agenda_ref) && T(x.agenda_stage); }).map(function (x) { return T(x.agenda_ref); })));
      var votesByLaw = {};
      for (var i = 0; i < refs.length; i += 50) {
        var chunk = refs.slice(i, i + 50);
        (await all('parl_votes', '*', function (q) { return q.in('law_name', chunk); })).forEach(function (v) { (votesByLaw[T(v.law_name)] = votesByLaw[T(v.law_name)] || []).push(v); });
      }
      rows.forEach(function (x) {
        var r = asHs(x), dateStr = T(r[0]); if (!dateStr) return;
        var number = T(r[1]), session = T(r[2]), chamber = T(r[3]), pronoun = T(r[4]), name = T(r[5]), role = T(r[6]),
            agendaRef = T(r[7]), agendaStage = T(r[8]), speechText = T(r[9]), ts = String(r[10] || '');
        var key = dateStr + '|' + number + '|' + session;
        if (!map[key]) { map[key] = { _key: key, date: dateStr, number: number, session: session, chamber: chamber, entries: [] }; order.push(key); }
        var isVote = !name && !speechText && agendaRef && agendaStage;
        var entry = { _rowIndex: x.id, type: isVote ? 'vote' : 'speech', pronoun: pronoun, name: name, role: role, agendaRef: agendaRef,
                      agendaStage: agendaStage, speechText: speechText, timestamp: ts, _sortKey: hansardTs(ts) };
        if (isVote) entry.vote = resolveVote(votesByLaw, agendaRef, agendaStage);
        map[key].entries.push(entry);
      });
      order.forEach(function (k) { map[k].entries.sort(function (a, b) { return a._sortKey - b._sortKey; }); });
      return order.reverse().map(function (k) { return map[k]; });
    });
  };

  /* ── 2. LOGIN / USERS ─────────────────────────────────────────────────────── */
  API.loginUser = async function (username, password) {
    var d = must(await sb.rpc('parl_login', { p_username: username, p_password: password }));
    if (d && d.ok && d.token) { setToken(d.token); }
    if (d) delete d.token;
    return d;
  };
  API.logoutUser = async function () {
    var t = token; setToken('');
    if (!t) return true;
    try {
      await fetch(CFG.SUPABASE_URL + '/rest/v1/rpc/parl_logout', { method: 'POST',
        headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'x-app-token': t }, body: '{}' });
    } catch (e) {}
    return true;
  };
  API.registerUser = async function (p) { return must(await sb.rpc('parl_register', { p: p })); };
  API.getUsersForAdmin = async function () { return must(await sb.rpc('parl_admin_list_users')) || []; };
  API.getPendingUsersForAdmin = async function () { return must(await sb.rpc('parl_admin_pending')) || []; };
  /* the requester's role/name sent by the page is ignored: the database uses the login token */
  API.adminUpdateUserMembership = async function (p) { return must(await sb.rpc('parl_admin_set_role', { p: { rowIndex: p.rowIndex, newMembership: p.newMembership } })); };
  API.adminResetPassword = async function (p) { return must(await sb.rpc('parl_admin_reset_password', { p: { rowIndex: p.rowIndex, newPassword: p.newPassword } })); };
  API.adminDeleteUser = async function (p) { return must(await sb.rpc('parl_admin_delete_user', { p: { rowIndex: p.rowIndex } })); };
  API.adminCreateUser = async function (p) { return must(await sb.rpc('parl_admin_create_user', { p: { pronoun: p.pronoun, username: p.username, password: p.password, membership: p.membership } })); };

  /* ── 3. QUESTIONS ─────────────────────────────────────────────────────────── */
  API.submitQuestion = async function (p) { var r = must(await sb.rpc('parl_submit_question', { p: p })); bust(); return r; };
  API.answerQuestion = async function (p) { var r = must(await sb.rpc('parl_answer_question', { p: { rowIndex: p.rowIndex, answer: p.answer, aDate: p.aDate } })); bust(); return r; };
  API.adminDeleteQuestion = function (rowIndex) {
    return guard(async function () { mustTouch(await sb.from('parl_questions').delete().eq('id', Number(rowIndex)).select('id')); return { ok: true }; });
  };
  API.adminEditQuestion = function (p) {
    return guard(async function () {
      mustTouch(await sb.from('parl_questions').update({ topic: T(p.topic), stories: T(p.stories), answer: T(p.answer) }).eq('id', Number(p.rowIndex)).select('id'));
      return { ok: true };
    });
  };

  /* ── 4. ADMIN: bills, laws, votes ─────────────────────────────────────────── */
  function voteRows(sheet, p, lookup, useLookup) {
    var introList = T(p.introducers).split(',').map(T).filter(Boolean), names = [], prons = [];
    introList.forEach(function (raw) { var x = lookup(raw); names.push(x.name); prons.push(x.pronoun); });
    var base = { sheet: sheet, law_name: T(p.lawName), stage: T(p.stage || p.newStage || p.oldStage), bill_side: T(p.billSide), draft_link: T(p.draftLink),
      pronoun_introducer: useLookup ? prons.join(', ') : '', introducer: useLookup ? names.join(', ') : T(p.introducers), date: T(p.date) };
    var voters = Array.isArray(p.voters) ? p.voters : [];
    if (!voters.length) return [Object.assign({}, base, { pronoun_voter: '', voter_name: '', vote: '', member_pos: '', voter_side: '' })];
    var out = [];
    voters.forEach(function (v) {
      if (!v.vote || v.vote === '') return;
      var pv, nm;
      if (useLookup) { var x = lookup(T(v.name)); pv = x.pronoun; nm = x.name; } else { pv = T(v.pronoun); nm = T(v.name); }
      out.push(Object.assign({}, base, { pronoun_voter: pv, voter_name: nm, vote: T(v.vote), member_pos: T(v.role), voter_side: T(v.side) }));
    });
    return out;
  }
  async function insertChunks(table, rows) {
    for (var i = 0; i < rows.length; i += 500) { must(await sb.from(table).insert(rows.slice(i, i + 500))); }
  }
  API.adminAddMotion = function (p) {
    return guard(async function () {
      if (!T(p.lawName)) return { ok: false, msg: 'กรุณากรอกชื่อร่างกฎหมาย' };
      if (!T(p.stage)) return { ok: false, msg: 'กรุณาเลือกวาระ' };
      await insertChunks('parl_votes', voteRows('VoteRecords', p, await pronounLookup(), true));
      return { ok: true };
    });
  };
  API.adminAddCommittee = function (p) {
    return guard(async function () {
      if (!T(p.lawName)) return { ok: false, msg: 'กรุณากรอกชื่อ' };
      if (!T(p.stage)) return { ok: false, msg: 'กรุณากรอกวาระ' };
      await insertChunks('parl_votes', voteRows('Committee', p, await pronounLookup(), true));
      return { ok: true };
    });
  };
  API.adminEditRecord = function (p) {
    return guard(async function () {
      var old = await all('parl_votes', 'id', function (q) { return q.eq('sheet', p.sheet).eq('law_name', T(p.lawName)).eq('stage', T(p.oldStage)); });
      var np = Object.assign({}, p, { stage: T(p.newStage || p.oldStage) });
      await insertChunks('parl_votes', voteRows(p.sheet, np, null, false));      // add the new rows first, so a failure never loses data
      var ids = old.map(function (x) { return x.id; });
      for (var i = 0; i < ids.length; i += 200) must(await sb.from('parl_votes').delete().in('id', ids.slice(i, i + 200)));
      return { ok: true };
    });
  };
  API.adminDeleteRecord = function (p) {
    return guard(async function () {
      var old = await all('parl_votes', 'id', function (q) { return q.eq('sheet', p.sheet).eq('law_name', T(p.lawName)).eq('stage', T(p.stage)); });
      if (!old.length) return { ok: false, msg: 'ไม่พบรายการ' };
      var ids = old.map(function (x) { return x.id; });
      for (var i = 0; i < ids.length; i += 200) mustTouch(await sb.from('parl_votes').delete().in('id', ids.slice(i, i + 200)).select('id'));
      return { ok: true };
    });
  };
  API.adminAddLaw = function (p) {
    return guard(async function () {
      if (!T(p.name)) return { ok: false, msg: 'กรุณากรอกชื่อกฎหมาย' };
      must(await sb.from('parl_law').insert({ name: T(p.name), type: T(p.type), link: T(p.link), date: T(p.date), status: T(p.status || 'มีผลบังคับใช้') }));
      return { ok: true };
    });
  };
  API.adminAddAmendment = function (p) {
    return guard(async function () {
      var parentName = T(p.parentName), aName = T(p.aName);
      if (!parentName) return { ok: false, msg: 'กรุณาเลือกกฎหมายหลัก' };
      if (!aName) return { ok: false, msg: 'กรุณากรอกชื่อฉบับแก้ไข' };
      var parent = must(await sb.from('parl_law').select('*').eq('name', parentName).order('id').limit(1));
      if (!parent.length) return { ok: false, msg: 'ไม่พบกฎหมายหลักในระบบ' };
      var pr = parent[0];
      must(await sb.from('parl_law').insert({ name: parentName, type: pr.type, link: pr.link, date: pr.date, status: pr.status,
        a_name: aName, a_link: T(p.aLink), a_date: T(p.aDate), a_status: T(p.aStatus || 'มีผลบังคับใช้') }));
      return { ok: true };
    });
  };

  /* ── 5. ADMIN: members ────────────────────────────────────────────────────── */
  function memberRow(p) {
    return { pronoun: T(p.pronoun), name: T(p.name), position: T(p.position), party: T(p.party), mp_type: T(p.mpType),
      in_office: T(p.inOffice), out_of_office: T(p.outOfOffice), picture: T(p.picture), party_color: T(p.partyColor) };
  }
  API.adminAddMember = function (p) {
    return guard(async function () {
      if (!T(p.name)) return { ok: false, msg: 'กรุณากรอกชื่อ' };
      if (!T(p.position)) return { ok: false, msg: 'กรุณากรอกตำแหน่ง' };
      must(await sb.from('parl_members').insert(memberRow(p)));
      return { ok: true };
    });
  };
  API.adminAddMemberWithRoles = function (p) {
    return guard(async function () {
      if (!T(p.name)) return { ok: false, msg: 'กรุณากรอกชื่อ' };
      if (!T(p.position)) return { ok: false, msg: 'กรุณากรอกตำแหน่งหลัก' };
      var rows = [memberRow(p)];
      (Array.isArray(p.additionalRoles) ? p.additionalRoles : []).forEach(function (r) {
        if (!T(r.position)) return;
        rows.push({ pronoun: T(p.pronoun), name: T(p.name), position: T(r.position), party: T(r.party), mp_type: '', in_office: T(r.inOffice),
          out_of_office: T(r.outOfOffice), picture: '', party_color: '' });
      });
      must(await sb.from('parl_members').insert(rows));
      return { ok: true };
    });
  };
  API.adminEditMember = function (p) {
    return guard(async function () {
      var id = Number(p.rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      mustTouch(await sb.from('parl_members').update(memberRow(p)).eq('id', id).select('id'));
      return { ok: true };
    });
  };
  API.adminDeleteMember = function (p) {
    return guard(async function () {
      var d = must(await sb.from('parl_members').delete().eq('name', T(p.name)).select('id'));
      if (!d.length) return { ok: false, msg: 'ไม่พบสมาชิก' };
      return { ok: true };
    });
  };
  API.adminDeleteMemberRow = function (p) {
    return guard(async function () {
      var id = Number(p.rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      mustTouch(await sb.from('parl_members').delete().eq('id', id).select('id'));
      return { ok: true };
    });
  };

  /* ── 6. ADMIN: cabinet ────────────────────────────────────────────────────── */
  API.getCabinetRawRows = async function (isShadow) {
    var rows = await loadCabinet(!!isShadow);
    return rows.map(function (r) { return { rowIndex: r.id, ministry: T(r[0]), pronoun: T(r[1]), name: T(r[2]), position: T(r[3]), party: T(r[4]), inOffice: T(r[5]), outOffice: T(r[6]) }; })
               .filter(function (r) { return r.ministry || r.name; });
  };
  API.adminAddCabinetMember = function (p) {
    return guard(async function () {
      if (!T(p.ministry)) return { ok: false, msg: 'กรุณากรอกชื่อคณะรัฐมนตรี' };
      if (!T(p.name)) return { ok: false, msg: 'กรุณากรอกชื่อสมาชิก' };
      if (!T(p.position)) return { ok: false, msg: 'กรุณากรอกตำแหน่ง' };
      must(await sb.from('parl_cabinet').insert({ is_shadow: !!p.isShadow, ministry: T(p.ministry), pronoun: T(p.pronoun), name: T(p.name),
        position: T(p.position), party: T(p.party), in_office: T(p.inOffice), out_of_office: T(p.outOffice) }));
      return { ok: true };
    });
  };
  API.adminEditCabinetMember = function (p) {
    return guard(async function () {
      var id = Number(p.rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      mustTouch(await sb.from('parl_cabinet').update({ ministry: T(p.ministry), pronoun: T(p.pronoun), name: T(p.name), position: T(p.position),
        party: T(p.party), in_office: T(p.inOffice), out_of_office: T(p.outOffice) }).eq('id', id).select('id'));
      return { ok: true };
    });
  };
  API.adminDeleteCabinetMember = function (p) {
    return guard(async function () {
      var id = Number(p.rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      mustTouch(await sb.from('parl_cabinet').delete().eq('id', id).select('id'));
      return { ok: true };
    });
  };
  API.adminAddCabinetBulk = function (p) {
    return guard(async function () {
      var ministry = T(p.ministry);
      if (!ministry) return { ok: false, msg: 'กรุณากรอกชื่อคณะรัฐมนตรี' };
      var members = Array.isArray(p.members) ? p.members : [];
      if (!members.length) return { ok: false, msg: 'กรุณาเพิ่มสมาชิกอย่างน้อย 1 คน' };
      var rows = [];
      members.forEach(function (m) {
        if (!T(m.name) || !T(m.position)) return;
        rows.push({ is_shadow: !!p.isShadow, ministry: ministry, pronoun: T(m.pronoun), name: T(m.name), position: T(m.position),
          party: T(m.party), in_office: T(m.inOffice), out_of_office: T(m.outOfOffice) });
      });
      if (!rows.length) return { ok: false, msg: 'ไม่มีสมาชิกที่สมบูรณ์ถูกเพิ่ม' };
      must(await sb.from('parl_cabinet').insert(rows));
      return { ok: true, added: rows.length };
    });
  };

  /* ── 7. ADMIN: agenda & hansard ───────────────────────────────────────────── */
  API.adminSaveAgenda = function (p) {
    return guard(async function () {
      var dateStr = T(p.date), number = T(p.number), session = T(p.session), chamber = T(p.chamber), note = T(p.note);
      if (!dateStr) return { ok: false, msg: 'กรุณาระบุวันที่' };
      var lookup = await pronounLookup(), rows = [];
      var mk = function (stage, topic, ip, intro, side, links) {
        return { date: dateStr, number: number, session: session, chamber: chamber, stage: stage, topic: topic, pronoun_introducer: ip, introducer: intro, side: side, links: links };
      };
      if (note) rows.push(mk(note, '', '', '', '', ''));
      (Array.isArray(p.items) ? p.items : []).forEach(function (item) {
        if (!item.text || !T(item.text)) return;
        var ip = '', iname = '';
        if (item.introducer && String(item.introducer).trim()) { var x = lookup(item.introducer); ip = x.pronoun; iname = x.name; }
        var sectionNum = item.type === 'urgent' ? 0 : Number(item.section) || 0;
        var label = (sectionNum === 0 && item.type === 'urgent') ? '(เรื่องด่วน)' : (AGENDA_SECTION_LABEL[sectionNum] || String(item.section || ''));
        rows.push(mk(label, T(item.text), ip, iname, T(item.side), T(item.url)));
      });
      (Array.isArray(p.footnotes) ? p.footnotes : []).forEach(function (fn) { if (fn && T(fn)) rows.push(mk('footnote:' + T(fn), '', '', '', '', '')); });
      if (rows.length) must(await sb.from('parl_agendas').insert(rows));
      return { ok: true };
    });
  };
  API.adminDeleteAgenda = function (p) {
    return guard(async function () {
      var parts = String(p.key || '').split('|');
      if (parts.length < 3) return { ok: false, msg: 'key ไม่ถูกต้อง' };
      must(await sb.from('parl_agendas').delete().eq('date', parts[0]).eq('number', parts[1]).eq('session', parts[2]));
      return { ok: true };
    });
  };
  API.adminEditAgendaRow = function (p) {
    return guard(async function () {
      var id = Number(p.rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      mustTouch(await sb.from('parl_agendas').update({ topic: T(p.text), introducer: T(p.introducer), links: T(p.url) }).eq('id', id).select('id'));
      return { ok: true };
    });
  };
  API.adminSaveHansardSitting = function (p) {
    return guard(async function () {
      var dateStr = T(p.date), number = T(p.number), session = T(p.session), chamber = T(p.chamber);
      if (!dateStr) return { ok: false, msg: 'กรุณาระบุวันที่' };
      var entries = Array.isArray(p.entries) ? p.entries : [];
      if (!entries.length) return { ok: false, msg: 'กรุณาเพิ่มอย่างน้อย 1 รายการ' };
      var members = await loadMembers(), pm = {};
      members.forEach(function (r) { var n = T(r[1]); if (n && !pm[n]) pm[n] = T(r[0]); });
      var rows = entries.map(function (e) {
        var isVote = e.type === 'vote', sp = T(e.name);
        return { date: dateStr, number: number, session: session, chamber: chamber,
          pronoun: isVote ? '' : (pm[sp] || T(e.pronoun)), name: isVote ? '' : sp, role: isVote ? '' : T(e.role),
          agenda_ref: T(e.agendaRef), agenda_stage: isVote ? T(e.agendaStage) : '', speech_text: isVote ? '' : T(e.speechText), ts: T(e.timestamp) };
      });
      await insertChunks('parl_hansard', rows);
      return { ok: true };
    });
  };
  API.adminDeleteHansardSitting = function (p) {
    return guard(async function () {
      var parts = String(p.key || '').split('|');
      if (parts.length < 3) return { ok: false, msg: 'key ไม่ถูกต้อง' };
      must(await sb.from('parl_hansard').delete().eq('date', parts[0]).eq('number', parts[1]).eq('session', parts[2]));
      return { ok: true };
    });
  };
  API.adminDeleteHansardRow = function (rowIndex) {
    return guard(async function () {
      var id = Number(rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      mustTouch(await sb.from('parl_hansard').delete().eq('id', id).select('id'));
      return { ok: true };
    });
  };
  API.adminEditHansardRow = function (p) {
    return guard(async function () {
      var id = Number(p.rowIndex); if (!id) return { ok: false, msg: 'rowIndex ไม่ถูกต้อง' };
      var isVote = p.type === 'vote';
      mustTouch(await sb.from('parl_hansard').update({ pronoun: isVote ? '' : T(p.pronoun), name: isVote ? '' : T(p.name), role: isVote ? '' : T(p.role),
        agenda_ref: T(p.agendaRef), agenda_stage: isVote ? T(p.agendaStage) : '', speech_text: isVote ? '' : T(p.speechText), ts: T(p.timestamp) }).eq('id', id).select('id'));
      return { ok: true };
    });
  };

  /* ── 8. member summary text (pure function, copied from Code.gs) ───────────── */
  API.analyseMember = async function (prompt) {
    try {
      var nameMatch = prompt.match(/ชื่อ:\s*(.+)/), posMatch = prompt.match(/ตำแหน่งหลัก:\s*(.+)/);
      var dateMatch = prompt.match(/เข้ารับตำแหน่ง:\s*(.+)/);
      var voteSection = prompt.match(/ประวัติการลงมติ \((\d+) รายการ\)/);
      var askedSection = prompt.match(/กระทู้ถามที่ตั้ง \((\d+) รายการ\)/);
      var answeredSection = prompt.match(/กระทู้ถามที่ตอบ \((\d+) รายการ\)/);
      var name = nameMatch ? nameMatch[1].trim() : 'สมาชิกท่านนี้';
      var position = posMatch ? posMatch[1].trim() : '';
      var dates = dateMatch ? dateMatch[1].trim() : '';
      var voteCount = voteSection ? parseInt(voteSection[1]) : 0;
      var askedCount = askedSection ? parseInt(askedSection[1]) : 0;
      var answeredCount = answeredSection ? parseInt(answeredSection[1]) : 0;
      var posLabel = position ? position.split('—')[0].trim() : 'สมาชิกรัฐสภา';
      var inOfficeDateStr = dates.split('ถึง')[0] ? dates.split('ถึง')[0].trim() : '';
      var outOfficeDateStr = dates.split('ถึง')[1] ? dates.split('ถึง')[1].trim() : 'ปัจจุบัน';
      var isMainIncumbent = outOfficeDateStr === 'ปัจจุบัน';
      var tenureMonths = 0;
      var parts = inOfficeDateStr.split('/');
      if (parts.length === 3) {
        var year = parseInt(parts[2]) > 2500 ? parseInt(parts[2]) - 543 : parseInt(parts[2]);
        var startDate = new Date(year, parseInt(parts[1]) - 1, parseInt(parts[0]));
        var now = new Date();
        tenureMonths = (now.getFullYear() - startDate.getFullYear()) * 12 + (now.getMonth() - startDate.getMonth());
        if (now.getDate() >= startDate.getDate()) tenureMonths += 1;
        if (tenureMonths < 0) tenureMonths = 0;
      }
      var rolesBlock = prompt.match(/ประวัติตำแหน่งทั้งหมด:\n([\s\S]+?)\n\nประวัติการลงมติ/);
      var allRoleLines = rolesBlock ? rolesBlock[1].trim().split('\n').filter(function (r) { return r.trim(); }) : [];
      var eliteRoles = ['นายกรัฐมนตรี', 'รักษาการนายกรัฐมนตรี', 'ผู้นำฝ่ายค้านในสภาผู้แทนราษฎร'];
      var isEliteRole = eliteRoles.some(function (role) { return posLabel.indexOf(role) !== -1; });
      var seniority = isEliteRole && tenureMonths >= 1 ? 'ผู้มีประสบการณ์ทางการเมืองระดับสูง'
        : tenureMonths < 4 ? 'สมาชิกใหม่ในบทบาททางรัฐสภา'
        : tenureMonths < 8 ? 'สมาชิกที่มีประสบการณ์ระดับปานกลาง' : 'สมาชิกที่มีประสบการณ์ทางรัฐสภา';
      var voteBlock = prompt.match(/ประวัติการลงมติ[\s\S]+?\n([\s\S]+?)\n\nกระทู้ถามที่ตั้ง/);
      var voteLines = voteBlock ? voteBlock[1].trim().split('\n') : [];
      var yesVotes = voteLines.filter(function (v) { return v.indexOf('เห็นชอบ') !== -1 && v.indexOf('ไม่เห็นชอบ') === -1; }).length;
      var noVotes = voteLines.filter(function (v) { return v.indexOf('ไม่เห็นชอบ') !== -1; }).length;
      var abstVotes = voteLines.filter(function (v) { return v.indexOf('งดออกเสียง') !== -1; }).length;
      var askedBlock = prompt.match(/กระทู้ถามที่ตั้ง[\s\S]+?\n([\s\S]+?)\n\nกระทู้ถามที่ตอบ/);
      var askedLines = askedBlock ? askedBlock[1].trim().split('\n').filter(function (l) { return l.trim() && l !== 'ไม่มีข้อมูล'; }) : [];
      var text = isMainIncumbent
        ? name + ' ดำรงตำแหน่ง' + posLabel + ' ตั้งแต่วันที่ ' + inOfficeDateStr
        : name + ' เคยดำรงตำแหน่ง' + posLabel + ' ตั้งแต่วันที่ ' + inOfficeDateStr + ' ถึง ' + outOfficeDateStr;
      if (tenureMonths > 0) text += ' รวมระยะเวลาประมาณ ' + tenureMonths + ' เดือน';
      text += seniority === 'สมาชิกใหม่ในบทบาททางรัฐสภา' ? ' และอยู่ในช่วงเริ่มต้นของบทบาททางรัฐสภา'
        : seniority === 'สมาชิกที่มีประสบการณ์ระดับปานกลาง' ? ' และมีประสบการณ์ในงานรัฐสภาระดับปานกลาง'
        : seniority === 'สมาชิกที่มีประสบการณ์ทางรัฐสภา' ? ' และมีประสบการณ์ทางรัฐสภา'
        : ' และเป็นผู้มีประสบการณ์ทางการเมืองระดับสูง';
      var extraRoles = allRoleLines.length - 1;
      if (extraRoles > 0) text += ' นอกจากนี้ยังเคยดำรงตำแหน่งอื่นอีก ' + extraRoles + ' ตำแหน่ง';
      text += ' ';
      if (voteCount > 0) {
        text += 'ในด้านการลงมติ ' + name + ' มีประวัติการลงมติรวม ' + voteCount + ' รายการ';
        var voteParts = [];
        if (yesVotes > 0) voteParts.push('เห็นชอบ ' + yesVotes + ' ครั้ง');
        if (noVotes > 0) voteParts.push('ไม่เห็นชอบ ' + noVotes + ' ครั้ง');
        if (abstVotes > 0) voteParts.push('งดออกเสียง ' + abstVotes + ' ครั้ง');
        if (voteParts.length > 0) text += ' ประกอบด้วย' + voteParts.join(' ');
        if (yesVotes > noVotes * 2 && yesVotes >= 2) text += ' ซึ่งสะท้อนแนวโน้มสนับสนุนนโยบายของฝ่ายรัฐบาล';
        else if (noVotes > yesVotes * 2 && noVotes >= 2) text += ' ซึ่งสะท้อนบทบาทฝ่ายค้านอย่างชัดเจน';
        text += ' ';
      }
      if (askedCount > 0) {
        text += 'ในด้านกระทู้ถาม ' + name + ' ได้ตั้งกระทู้ถามจำนวน ' + askedCount + ' รายการ';
        var topics = askedLines.slice(0, 2).map(function (l) { var m = l.match(/เรื่อง "?(.+?)"?$/); return m ? m[1] : ''; }).filter(Boolean);
        if (topics.length > 0) text += ' ครอบคลุมประเด็น เช่น ' + topics.join(' และ ');
        text += ' ';
      }
      if (answeredCount > 0) text += name + ' ยังมีบทบาทในการตอบกระทู้ถามจำนวน ' + answeredCount + ' รายการ ';
      text += 'โดยสรุป ' + name + ' ถือเป็น' + seniority;
      text += ' โดยมีประสบการณ์จากการดำรงตำแหน่งรวม ' + allRoleLines.length + ' ตำแหน่ง';
      if (voteCount > 0) text += ' และมีประวัติการลงมติ ' + voteCount + ' รายการ';
      if (askedCount + answeredCount > 0) text += ' รวมถึงการมีส่วนร่วมด้านกระทู้ถาม ' + (askedCount + answeredCount) + ' รายการ';
      return text;
    } catch (e) { return 'ERROR: ' + e.message; }
  };

  /* ── 9. google.script.run look-alike ──────────────────────────────────────── */
  function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
  function runner(ok, fail) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return runner(fn, fail); };
        if (name === 'withFailureHandler') return function (fn) { return runner(ok, fn); };
        if (name === 'withUserObject') return function () { return runner(ok, fail); };
        return function () {
          var args = arguments, f = API[name];
          Promise.resolve().then(function () {
            if (!f) throw new Error('Unknown server function: ' + String(name));
            return f.apply(null, args);
          }).then(function (r) { if (ok) ok(clone(r)); },
                  function (e) { console.error(String(name), e); if (fail) fail(e); });
        };
      }
    });
  }
  window.google = { script: { run: runner(null, null) } };
  window.__parlApi = API;

  /* the page keeps who-I-am in sessionStorage; make sure it matches a real login */
  document.addEventListener('DOMContentLoaded', function () {
    var stored = null;
    try { stored = JSON.parse(sessionStorage.getItem('_parl_session') || 'null'); } catch (e) {}
    function wipe() { try { sessionStorage.removeItem('_parl_session'); sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} token = ''; location.reload(); }
    if (!token) { if (stored && stored.loggedIn) wipe(); return; }
    sb.rpc('parl_me').then(function (r) {
      var me = r.data;
      if (r.error && !me) return;                                  // offline: keep what we have
      if (!me || !me.ok) return wipe();
      if (!stored || !stored.loggedIn || stored.membership !== me.membership || stored.username !== me.username) {
        try { sessionStorage.setItem('_parl_session', JSON.stringify({ loggedIn: true, username: me.username, membership: me.membership, pronoun: me.pronoun || '' })); } catch (e) {}
        location.reload();
      }
    });
  });
})();
