// Legacy compact CallLog shortcuts accepted only so migration can restore full field names:
// call=callId, c=chatId, ca=callerId, r=receiverId, mt=mediaType (0 audio, 1 video),
// sts=status, term=terminationReason, cr=createdAt, rng=ringingAt,
// con=connectedAt, end=endedAt, dur=durationSeconds.
function callLogForStorage(log) {
  if (Object.prototype.hasOwnProperty.call(log, "call")) return callLogForClient(log);
  return { ...log };
}

function callLogForClient(log) {
  if (!log || typeof log !== "object") throw new TypeError("Invalid CallLog record");
  if (!Object.prototype.hasOwnProperty.call(log, "mt")) return { ...log };
  if (!(log.mt === 0 || log.mt === 1)) throw new TypeError("Invalid CallLog media type");
  return {
    callId: String(log.call), chatId: String(log.c || ""),
    callerId: String(log.ca), receiverId: String(log.r),
    mediaType: log.mt === 1 ? "video" : "audio", status: String(log.sts),
    terminationReason: String(log.term), createdAt: Number(log.cr),
    ringingAt: log.rng == null ? null : Number(log.rng),
    connectedAt: log.con == null ? null : Number(log.con), endedAt: Number(log.end),
    durationSeconds: Math.max(0, Number(log.dur) || 0),
  };
}

// Legacy compact Report shortcuts accepted only so migration can restore full field names:
// each item: id=messageId, s=reporterId, r=reportedUserId, rsn=reason, st=createdAt.
function reportForStorage(report) {
  if (Object.prototype.hasOwnProperty.call(report, "c")) return reportForInternal(report);
  return { ...report, messages: (report.messages || []).map((item) => ({ ...item })) };
}

function reportForInternal(report) {
  if (report && typeof report === "object" && Array.isArray(report.messages)) {
    return { ...report, messages: report.messages.map((item) => ({ ...item })) };
  }
  if (!report || typeof report !== "object" || !Array.isArray(report.m)) {
    throw new TypeError("Invalid Reports record");
  }
  return {
    chatId: String(report.c),
    messages: report.m.map((item) => ({
      messageId: String(item.id), reporterId: String(item.s),
      reportedUserId: String(item.r), reason: String(item.rsn), createdAt: Number(item.st),
    })),
  };
}

module.exports = { callLogForStorage, callLogForClient, reportForStorage, reportForInternal };
