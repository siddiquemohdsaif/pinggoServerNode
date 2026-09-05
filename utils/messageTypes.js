const MESSAGE_TYPE_CODES = Object.freeze({
  // Shortcuts: 0 text, 1 image, 2 video, 3 audio, 4 file, 5 location,
  // 6 voice_call, 7 video_call, 8 report, 9 chat_report, 10 chat_block, 11 chat_unblock.
  //
  // Compact message-field shortcuts (documentation only; persistence currently keeps full names):
  // id=messageId, cid=clientMessageId, c=chatId, s=senderId, r=receiverId,
  // t=messageTypeCode, txt=text/caption, rt=repliedMessageId, st=sentTime,
  // dt=deliveredTime, rdt=readTime, sts=status, aid=attachmentId.
  // Attachment: ak=kind, an=name, am=mimeType, az=size, au=remoteUrl,
  // al=localUri (Android only), aw=width, ah=height, ao=orientation,
  // ad=durationMs, ash=sha256.
  // Location: lat=latitude, lng=longitude, acc=accuracy.
  // Message state: p=pinned, pat=pinnedAt, pby=pinnedBy, ff=forwardedFrom,
  // del=deletedText, inv=invisible.
  // Calls: call=callId, dur=callDurationSeconds, cr=callCreatedAt,
  // rng=callRingingAt, con=callConnectedAt, end=callEndedAt,
  // term=callTerminationReason.
  text: 0, image: 1, video: 2, audio: 3, file: 4, location: 5,
  voice_call: 6, video_call: 7, report: 8, chat_report: 9,
  chat_block: 10, chat_unblock: 11,
});
const MESSAGE_TYPES = Object.freeze(Object.fromEntries(
  Object.entries(MESSAGE_TYPE_CODES).map(([name, code]) => [code, name]),
));

function clean(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : String(value ?? "");
}

function encodeMessageType(value) {
  if (Number.isInteger(value) && Object.prototype.hasOwnProperty.call(MESSAGE_TYPES, value)) return value;
  const name = clean(value);
  if (Object.prototype.hasOwnProperty.call(MESSAGE_TYPE_CODES, name)) return MESSAGE_TYPE_CODES[name];
  throw new TypeError(`Invalid message type: ${value}`);
}

function decodeMessageType(value) {
  if (!Number.isInteger(value) || !Object.prototype.hasOwnProperty.call(MESSAGE_TYPES, value)) {
    throw new TypeError(`Invalid message type code: ${value}`);
  }
  return MESSAGE_TYPES[value];
}

function forStorage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  if (Object.prototype.hasOwnProperty.call(message, "t")) {
    return forStorage(forClient(message));
  }
  return { ...message, messageType: encodeMessageType(message.messageType) };
  /* Compact storage was removed. Full descriptive field names are retained.
  const compact = {
    id: message.id, cid: message.clientMessageId ?? null, c: message.chatId,
    s: message.senderId, r: message.receiverId, txt: message.text ?? "",
    t: encodeMessageType(message.messageType), st: message.sentTime,
    dt: message.deliveredTime ?? null, rdt: message.readTime ?? null,
    sts: message.status, inv: message.invisible ?? [],
  };
  const optional = {
    rt: message.repliedMessageId, p: message.pinned, pat: message.pinned_at ?? message.pinnedAt,
    pby: message.pinnedBy, ff: message.forwarded_from ?? message.forwardedFrom,
    del: message.deletedText, call: message.callId, dur: message.callDurationSeconds,
    cr: message.callCreatedAt, rng: message.callRingingAt, con: message.callConnectedAt,
    end: message.callEndedAt, term: message.callTerminationReason,
    ctxt: message.callerText, rtxt: message.receiverText, rr: message.reportReason,
    fo: message.forward_operation_id, fmid: message.forwarded_message_id,
    clr: message.cleared,
  };
  for (const [key, value] of Object.entries(optional)) if (value != null) compact[key] = value;
  if (message.attachment) {
    const a = message.attachment;
    compact.aid = a.id; compact.ak = a.kind; compact.an = a.name;
    compact.am = a.mimeType; compact.az = a.size; compact.au = a.url;
    if (a.width != null) compact.aw = a.width;
    if (a.height != null) compact.ah = a.height;
    if (a.orientation != null) compact.ao = a.orientation;
    if (a.durationMs != null) compact.ad = a.durationMs;
    if (a.sha256 != null) compact.ash = a.sha256;
  }
  if (message.location) {
    compact.lat = message.location.latitude;
    compact.lng = message.location.longitude;
    if (message.location.accuracy != null) compact.acc = message.location.accuracy;
  }
  return compact; */
}

function forClient(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  if (!Object.prototype.hasOwnProperty.call(message, "t")) {
    return { ...message, messageType: decodeMessageType(message.messageType) };
  }
  const expanded = {
    id: message.id, clientMessageId: message.cid ?? null, chatId: message.c,
    senderId: message.s, receiverId: message.r, text: message.txt ?? "",
    messageType: decodeMessageType(message.t), sentTime: message.st,
    deliveredTime: message.dt ?? null, readTime: message.rdt ?? null,
    status: message.sts, invisible: message.inv ?? [],
  };
  const optional = {
    repliedMessageId: message.rt, pinned: message.p, pinned_at: message.pat,
    pinnedBy: message.pby, forwardedFrom: message.ff, deletedText: message.del,
    callId: message.call, callDurationSeconds: message.dur, callCreatedAt: message.cr,
    callRingingAt: message.rng, callConnectedAt: message.con, callEndedAt: message.end,
    callTerminationReason: message.term, callerText: message.ctxt,
    receiverText: message.rtxt, reportReason: message.rr,
    forward_operation_id: message.fo, forwarded_message_id: message.fmid,
    cleared: message.clr,
  };
  for (const [key, value] of Object.entries(optional)) if (value != null) expanded[key] = value;
  if (message.aid != null) expanded.attachment = {
    id: message.aid, kind: message.ak, name: message.an, mimeType: message.am,
    size: message.az, url: message.au,
    ...(message.aw != null ? { width: message.aw } : {}),
    ...(message.ah != null ? { height: message.ah } : {}),
    ...(message.ao != null ? { orientation: message.ao } : {}),
    ...(message.ad != null ? { durationMs: message.ad } : {}),
    ...(message.ash != null ? { sha256: message.ash } : {}),
  };
  if (message.lat != null && message.lng != null) expanded.location = {
    latitude: message.lat, longitude: message.lng,
    ...(message.acc != null ? { accuracy: message.acc } : {}),
  };
  return expanded;
}

function chatForInternal(chat) {
  if (!chat || typeof chat !== "object") return chat;
  return Object.fromEntries(Object.entries(chat).map(([key, value]) =>
    [key, key === "_id" ? value : forClient(value)]));
}

function chatForClient(chat) {
  if (!chat || typeof chat !== "object") return chat;
  return Object.fromEntries(Object.entries(chat).map(([key, value]) =>
    [key, key === "_id" ? value : forStorage(value)]));
}

module.exports = { MESSAGE_TYPE_CODES, encodeMessageType, decodeMessageType,
  forStorage, forClient, chatForClient, chatForInternal };
