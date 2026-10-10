/**
 * ExportForSupabase.gs — run ONCE in your existing Apps Script project
 * (the one that has Code.gs), then send me the JSON file it creates.
 *
 * How: paste this file into the Apps Script editor as a new file,
 * choose function  exportForSupabase  and press Run (allow Drive access if asked).
 * Open View > Logs: it prints the link of the file  parliament-export.json  in your Drive.
 *
 * Passwords are NOT exported in plain text: each one is converted to a SHA-256 hash
 * ("sha256:<hex>"), and the site upgrades it to a stronger hash the first time that
 * person logs in. Delete the JSON file from Drive after the import.
 */
function exportForSupabase() {
  var ss = SpreadsheetApp.openById("1qx79dojAl1zxgbOn0CvlpSJY89vQgNxN28aZQSN3u68");
  function rows(name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return [];
    return sh.getDataRange().getDisplayValues().slice(1).filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ""; });
    });
  }
  function s(v) { return v == null ? "" : String(v).trim(); }
  function sha(p) {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
    return "sha256:" + d.map(function (b) { return ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join("");
  }
  function validRole(m) {
    m = s(m).toLowerCase();
    return ["headadmin", "admin", "member", "user", "waiting"].indexOf(m) >= 0 ? m : "waiting";
  }

  var out = {};
  out.parl_users = rows("Login").filter(function (r) { return s(r[1]) && s(r[3]); }).map(function (r) {
    return { pronoun: s(r[0]), username: s(r[1]), discord: s(r[2]), password_hash: sha(String(r[3])), link: s(r[4]), membership: validRole(r[5]) };
  });
  out.parl_law = rows("Law").map(function (r) {
    return { name: s(r[0]), type: s(r[1]), link: s(r[2]), date: s(r[3]), status: s(r[4]), a_name: s(r[5]), a_link: s(r[6]), a_date: s(r[7]), a_status: s(r[8]) };
  });
  ["VoteRecords", "Committee"].forEach(function (sheet) {
    rows(sheet).forEach(function (r) {
      (out.parl_votes = out.parl_votes || []).push({ sheet: sheet, law_name: s(r[0]), stage: s(r[1]), bill_side: s(r[2]), draft_link: s(r[3]),
        pronoun_introducer: s(r[4]), introducer: s(r[5]), pronoun_voter: s(r[6]), voter_name: s(r[7]), vote: s(r[8]), member_pos: s(r[9]), voter_side: s(r[10]), date: s(r[11]) });
    });
  });
  out.parl_members = rows("Members").map(function (r) {
    return { pronoun: s(r[0]), name: s(r[1]), position: s(r[2]), party: s(r[3]), mp_type: s(r[4]), in_office: s(r[5]), out_of_office: s(r[6]), picture: s(r[7]), party_color: s(r[8]) };
  });
  out.parl_cabinet = [];
  [["Cabinet", false], ["ShadowCabinet", true]].forEach(function (c) {
    rows(c[0]).forEach(function (r) {
      out.parl_cabinet.push({ is_shadow: c[1], ministry: s(r[0]), pronoun: s(r[1]), name: s(r[2]), position: s(r[3]), party: s(r[4]), in_office: s(r[5]), out_of_office: s(r[6]), picture: s(r[7]), party_color: s(r[8]) });
    });
  });
  out.parl_questions = rows("Question").map(function (r) {
    return { pronoun_asker: s(r[0]), ask_name: s(r[1]), a_role: s(r[2]), a_ministry: s(r[3]), pronoun_who: s(r[4]), to_who: s(r[5]), position: s(r[6]), ministry: s(r[7]), topic: s(r[8]), stories: s(r[9]), date: s(r[10]), answer: s(r[11]), a_date: s(r[12]) };
  });
  out.parl_petitions = rows("Petition").map(function (r) {
    return { name: s(r[0]), type: s(r[1]), link: s(r[2]), cur: s(r[3]), goal: s(r[4]), status: s(r[5]), pronoun: s(r[6]), presenter: s(r[7]), pronoun_petitioner: s(r[8]), petitioners: s(r[9]), approval: s(r[10]) };
  });
  out.parl_agendas = rows("Agenda").map(function (r) {
    return { date: s(r[0]), number: s(r[1]), session: s(r[2]), chamber: s(r[3]), stage: s(r[4]), topic: s(r[5]), pronoun_introducer: s(r[6]), introducer: s(r[7]), side: s(r[8]), links: s(r[9]) };
  });
  out.parl_hansard = rows("Hansard").map(function (r) {
    return { date: s(r[0]), number: s(r[1]), session: s(r[2]), chamber: s(r[3]), pronoun: s(r[4]), name: s(r[5]), role: s(r[6]), agenda_ref: s(r[7]), agenda_stage: s(r[8]), speech_text: s(r[9]), ts: s(r[10]) };
  });

  var file = DriveApp.createFile("parliament-export.json", JSON.stringify(out), "application/json");
  var counts = Object.keys(out).map(function (k) { return k + ": " + out[k].length; }).join("\n");
  Logger.log(counts + "\n\nFile: " + file.getUrl());
}
