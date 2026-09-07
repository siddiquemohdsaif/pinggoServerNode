function callLogForStorage(log) {
  return canonicalCallLog(log);
}

function callLogForClient(log) {
  return canonicalCallLog(log);
}

function canonicalCallLog(log) {
  if (!log || typeof log !== "object") throw new TypeError("Invalid CallLog record");
  if (log.mediaType !== "audio" && log.mediaType !== "video") {
    throw new TypeError("Invalid CallLog media type");
  }
  return { ...log };
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
