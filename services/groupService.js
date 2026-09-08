const crypto = require("crypto");
const FirestoreManager = require("../Firestore/FirestoreManager");
const { getUserSocket, isUserViewingChat } = require("../realtime/connectionManager");
const { nextTimestamp } = require("../utils/timestampId");
const { forStorage } = require("../utils/messageTypes");
const { sendOfflineMessageNotification } = require("../realtime/fcmService");

const firestore = FirestoreManager.getInstance();
const MAX_MEMBERS = 1024;

function accountId(value) {
  return typeof value === "string" ? value.trim().replace(/^<plus>/, "").replace(/^\+/, "") : "";
}
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function withoutId(value) { const copy = { ...value }; delete copy._id; return copy; }
function activeMember(group, userId) {
  const member = group && group.members && group.members[accountId(userId)];
  return member && member.status === "active" ? member : null;
}
function isAdmin(group, userId) { return activeMember(group, userId)?.role === "admin"; }
function publicGroup(group) {
  if (!group) return null;
  return { ...withoutId(group), members: Object.values(group.members || {}) };
}
async function readGroup(groupId) {
  try { return await firestore.readDocument("Groups", text(groupId), "/"); }
  catch (_error) { return null; }
}
async function writeGroup(group) {
  const stored = withoutId(group);
  try { return await firestore.updateDocument("Groups", group.groupId, "/", stored); }
  catch (_error) { return firestore.createDocument("Groups", group.groupId, "/", stored); }
}
async function readChat(groupId) {
  try { return await firestore.readDocument("Chats", groupId, "/"); }
  catch (_error) { return null; }
}
async function ensureChat(groupId) {
  if (await readChat(groupId)) return;
  try { await firestore.createDocument("Chats", groupId, "/", {}); } catch (_error) {}
}
function defaultChatSettings(group) {
  return { pinned: false, notification_muted: "0", archieved: false, unread_count: 0,
    last_message: null, chat_type: "group", group_id: group.groupId, group_name: group.name,
    group_icon: group.icon || null };
}
async function mutateChatList(userId, mutate) {
  const id = accountId(userId);
  let doc = null;
  try { doc = await firestore.readDocument("ChatsList", id, "/"); } catch (_error) {}
  const raw = doc && doc.list;
  const list = Array.isArray(raw) ? Object.fromEntries(raw.map((key) => [key, {}])) : { ...(raw || {}) };
  mutate(list);
  const body = { ...withoutId(doc || {}), list };
  try { await firestore.updateDocument("ChatsList", id, "/", body); }
  catch (_error) { await firestore.createDocument("ChatsList", id, "/", body); }
}
async function addToChatList(userId, group) {
  await mutateChatList(userId, (list) => {
    list[group.groupId] = { ...defaultChatSettings(group), ...(list[group.groupId] || {}),
      chat_type: "group", group_id: group.groupId, group_name: group.name, group_icon: group.icon || null };
  });
}
async function updateListMetadata(group) {
  await Promise.all(Object.values(group.members || {}).filter((m) => m.status === "active")
    .map((m) => addToChatList(m.userId, group)));
}
async function removeFromChatList(userId, groupId) {
  await mutateChatList(userId, (list) => { delete list[groupId]; });
}
function send(userId, payload) {
  const socket = getUserSocket(accountId(userId));
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
}
function broadcast(group, payload, except) {
  Object.values(group.members || {}).filter((m) => m.status === "active" && m.userId !== except)
    .forEach((m) => send(m.userId, payload));
}
async function systemMessage(group, actorId, event, targetIds = [], metadata = {}) {
  await ensureChat(group.groupId);
  const sentTime = nextTimestamp();
  const message = { id: String(sentTime), chatId: group.groupId, groupId: group.groupId,
    senderId: accountId(actorId), messageType: "group_system", text: "", sentTime,
    status: "sent", systemEvent: { event, actorId: accountId(actorId), targetIds, ...metadata },
    receipts: {} };
  await firestore.updateDocument("Chats", group.groupId, "/", { [message.id]: forStorage(message) });
  await fanOutMessage(group, message, actorId);
  return message;
}
async function fanOutMessage(group, message, senderId) {
  const members = Object.values(group.members || {}).filter((m) => m.status === "active");
  await Promise.all(members.map((m) => mutateChatList(m.userId, (list) => {
    const settings = { ...defaultChatSettings(group), ...(list[group.groupId] || {}) };
    settings.last_message = message;
    if (m.userId !== accountId(senderId) && !isUserViewingChat(m.userId, group.groupId)) {
      settings.unread_count = (Number(settings.unread_count) || 0) + 1;
    }
    list[group.groupId] = settings;
  })));
  members.forEach((m) => {
    send(m.userId, { type: "new_group_message", message, groupName: group.name,
      groupIcon: group.icon || null });
    if (m.userId !== accountId(senderId) && !getUserSocket(accountId(m.userId))) {
      sendOfflineMessageNotification({ receiverId: m.userId, message, group })
        .catch((error) => console.error("Could not send group notification:", error.message));
    }
  });
}
function requireMember(group, userId) {
  if (!group) { const e = new Error("Group not found."); e.statusCode = 404; throw e; }
  if (!activeMember(group, userId)) { const e = new Error("Active group membership required."); e.statusCode = 403; throw e; }
}
function requireAdmin(group, userId) {
  requireMember(group, userId);
  if (!isAdmin(group, userId)) { const e = new Error("Group administrator permission required."); e.statusCode = 403; throw e; }
}

async function createGroup({ creatorId, name, description, icon, memberIds }) {
  creatorId = accountId(creatorId); name = text(name);
  if (!creatorId || !name) throw new Error("creatorId and name are required.");
  const ids = [...new Set([creatorId, ...(memberIds || []).map(accountId)].filter(Boolean))];
  if (ids.length < 2) throw new Error("A group requires at least two members.");
  if (ids.length > MAX_MEMBERS) throw new Error(`A group supports at most ${MAX_MEMBERS} members.`);
  const now = Date.now();
  const groupId = `grp_${now}_${crypto.randomBytes(6).toString("hex")}`;
  const members = Object.fromEntries(ids.map((userId) => [userId, { userId,
    role: userId === creatorId ? "admin" : "member", status: "active", joinedAt: now,
    leftAt: null, addedBy: creatorId }]));
  const group = { groupId, name: name.slice(0, 100), description: text(description).slice(0, 2048),
    icon: text(icon) || null, createdBy: creatorId, createdAt: now, updatedAt: now,
    membershipVersion: 1, permissions: { sendMessages: "members", editInfo: "admins",
      addMembers: "admins", approveMembers: "admins" }, members, invite: null };
  await writeGroup(group); await ensureChat(groupId);
  await Promise.all(ids.map((id) => addToChatList(id, group)));
  await systemMessage(group, creatorId, "group_created", ids.filter((id) => id !== creatorId));
  broadcast(group, { type: "group_created", group: publicGroup(group) });
  return group;
}

async function changeMembers(groupId, actorId, memberIds, action) {
  const group = await readGroup(groupId); requireAdmin(group, actorId);
  const ids = [...new Set((memberIds || []).map(accountId).filter(Boolean))];
  if (!ids.length) throw new Error("memberIds must contain at least one user.");
  if (action === "remove" && ids.includes(accountId(actorId))) throw new Error("Use leave group to remove yourself.");
  const activeCount = Object.values(group.members || {}).filter((m) => m.status === "active").length;
  if (action === "add" && activeCount + ids.filter((id) => !activeMember(group, id)).length > MAX_MEMBERS) throw new Error("Group capacity exceeded.");
  const now = Date.now();
  for (const id of ids) {
    if (action === "add") group.members[id] = { userId: id, role: "member", status: "active",
      joinedAt: now, leftAt: null, addedBy: accountId(actorId) };
    else if (activeMember(group, id)) group.members[id] = { ...group.members[id], status: "removed",
      leftAt: now, removedBy: accountId(actorId) };
  }
  group.updatedAt = now; group.membershipVersion = (group.membershipVersion || 0) + 1;
  await writeGroup(group);
  if (action === "add") await Promise.all(ids.map((id) => addToChatList(id, group)));
  else await Promise.all(ids.map((id) => removeFromChatList(id, groupId)));
  await systemMessage(group, actorId, action === "add" ? "members_added" : "members_removed", ids);
  ids.forEach((id) => send(id, { type: action === "add" ? "group_added" : "group_removed", groupId,
    group: action === "add" ? publicGroup(group) : undefined }));
  broadcast(group, { type: "group_updated", group: publicGroup(group) });
  return group;
}

async function leaveGroup(groupId, userId) {
  const group = await readGroup(groupId); requireMember(group, userId);
  const id = accountId(userId); const now = Date.now();
  const wasAdmin = isAdmin(group, id);
  group.members[id] = { ...group.members[id], status: "left", leftAt: now };
  if (wasAdmin && !Object.values(group.members).some((m) => m.status === "active" && m.role === "admin")) {
    const successor = Object.values(group.members).filter((m) => m.status === "active")
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (successor) group.members[successor.userId] = { ...successor, role: "admin", promotedAt: now };
  }
  group.updatedAt = now; group.membershipVersion = (group.membershipVersion || 0) + 1;
  await writeGroup(group); await removeFromChatList(id, groupId);
  await systemMessage(group, id, "member_left", [id]);
  send(id, { type: "group_left", groupId });
  broadcast(group, { type: "group_updated", group: publicGroup(group) });
  return group;
}

async function setRole(groupId, actorId, memberId, role) {
  const group = await readGroup(groupId); requireAdmin(group, actorId);
  memberId = accountId(memberId); role = text(role);
  if (!activeMember(group, memberId) || !["admin", "member"].includes(role)) throw new Error("Valid active member and role are required.");
  if (memberId === accountId(actorId) && role === "member" &&
      Object.values(group.members).filter((m) => m.status === "active" && m.role === "admin").length === 1) {
    throw new Error("The group must retain at least one administrator.");
  }
  group.members[memberId] = { ...group.members[memberId], role, roleChangedAt: Date.now(), roleChangedBy: accountId(actorId) };
  group.updatedAt = Date.now(); await writeGroup(group);
  await systemMessage(group, actorId, role === "admin" ? "admin_promoted" : "admin_demoted", [memberId]);
  broadcast(group, { type: "group_updated", group: publicGroup(group) }); return group;
}

async function updateGroup(groupId, actorId, changes) {
  const group = await readGroup(groupId); requireAdmin(group, actorId);
  if (changes.name !== undefined) { const value = text(changes.name); if (!value) throw new Error("name cannot be empty."); group.name = value.slice(0, 100); }
  if (changes.description !== undefined) group.description = text(changes.description).slice(0, 2048);
  if (changes.icon !== undefined) group.icon = text(changes.icon) || null;
  if (changes.permissions !== undefined) {
    const allowed = ["members", "admins"]; const next = { ...group.permissions };
    for (const key of ["sendMessages", "editInfo", "addMembers", "approveMembers"]) if (changes.permissions[key] !== undefined) {
      if (!allowed.includes(changes.permissions[key])) throw new Error(`Invalid permission: ${key}.`);
      next[key] = changes.permissions[key];
    }
    group.permissions = next;
  }
  group.updatedAt = Date.now(); await writeGroup(group); await updateListMetadata(group);
  await systemMessage(group, actorId, "group_info_updated");
  broadcast(group, { type: "group_updated", group: publicGroup(group) }); return group;
}

async function sendGroupMessage(ws, payload, sendJson) {
  const groupId = text(payload.groupId || payload.chatId); const senderId = accountId(payload.senderId || ws.userId);
  try {
    const group = await readGroup(groupId); requireMember(group, senderId);
    if (senderId !== accountId(ws.userId)) throw Object.assign(new Error("senderId must match authenticated user."), { statusCode: 403 });
    if (group.permissions?.sendMessages === "admins" && !isAdmin(group, senderId)) throw Object.assign(new Error("Only administrators can send messages."), { statusCode: 403 });
    const messageText = text(payload.text); const messageType = text(payload.messageType || "text").toLowerCase();
    if (!messageText && messageType === "text") throw new Error("text is required.");
    const chat = await readChat(groupId);
    const clientMessageId = text(payload.clientMessageId || payload.localMessageId);
    const duplicate = clientMessageId && chat && Object.values(chat).find((m) => m && m.clientMessageId === clientMessageId && accountId(m.senderId) === senderId);
    if (duplicate) { sendJson(ws, { type: "group_message_ack", clientMessageId, message: duplicate }); return; }
    let attachment = payload.attachment || null;
    const attachmentId = text(payload.attachmentId);
    if (!attachment && attachmentId) {
      try { attachment = await firestore.readDocument("ChatAttachments", attachmentId, "/"); }
      catch (_error) { attachment = null; }
      if (!attachment || attachment.chatId !== groupId || accountId(attachment.uploaderId) !== senderId ||
          attachment.status !== "pending" || attachment.kind !== messageType) {
        throw new Error("Attachment is invalid or unavailable.");
      }
      attachment = { id: attachment.id || attachmentId, kind: attachment.kind, name: attachment.name,
        mimeType: attachment.mimeType, size: attachment.size, url: attachment.url,
        width: payload.attachmentWidth || attachment.width, height: payload.attachmentHeight || attachment.height,
        orientation: payload.attachmentOrientation || attachment.orientation,
        durationMs: payload.attachmentDurationMs || attachment.durationMs, sha256: attachment.sha256 };
    }
    const sentTime = nextTimestamp(); const message = { id: String(sentTime), clientMessageId: clientMessageId || null,
      chatId: groupId, groupId, senderId, text: messageText, messageType, sentTime, status: "sent", receipts: {} };
    if (payload.repliedMessageId) message.repliedMessageId = text(payload.repliedMessageId);
    if (attachment) message.attachment = attachment;
    if (payload.location) message.location = payload.location;
    await ensureChat(groupId); await firestore.updateDocument("Chats", groupId, "/", {
      [message.id]: forStorage(message),
    });
    if (attachmentId) await firestore.updateDocument("ChatAttachments", attachmentId, "/", {
      ...withoutId(await firestore.readDocument("ChatAttachments", attachmentId, "/")), status: "used",
      messageId: message.id, usedAt: sentTime,
    });
    await fanOutMessage(group, message, senderId);
    sendJson(ws, { type: "group_message_ack", clientMessageId, messageId: message.id, chatId: groupId,
      status: "sent", sentTime, message });
  } catch (error) { sendJson(ws, { type: "group_message_failed", groupId, clientMessageId: payload.clientMessageId || null, message: error.message }); }
}

async function markGroupMessages(ws, payload, sendJson, state) {
  const groupId = text(payload.groupId || payload.chatId); const userId = accountId(ws.userId);
  try {
    const group = await readGroup(groupId); requireMember(group, userId);
    const chat = await readChat(groupId); const ids = [...new Set((payload.messageIds || []).map(text).filter(Boolean))];
    if (!ids.length) throw new Error("messageIds must be a non-empty array.");
    const at = Date.now(); const updates = {};
    ids.forEach((id) => { const message = chat && chat[id]; if (!message) return;
      const receipt = { ...((message.receipts || {})[userId] || {}) };
      if (state === "delivered") receipt.deliveredAt = receipt.deliveredAt || at;
      else { receipt.deliveredAt = receipt.deliveredAt || at; receipt.readAt = receipt.readAt || at; }
      updates[id] = { ...message, receipts: { ...(message.receipts || {}), [userId]: receipt } };
    });
    if (!Object.keys(updates).length) throw new Error("No messages found.");
    await firestore.updateDocument("Chats", groupId, "/", updates);
    if (state === "read") await mutateChatList(userId, (list) => { if (list[groupId]) list[groupId].unread_count = 0; });
    const event = { type: state === "read" ? "group_message_seen" : "group_message_delivered",
      groupId, messageIds: Object.keys(updates), userId, at };
    sendJson(ws, { ...event, type: `${event.type}_ack` }); broadcast(group, event, userId);
  } catch (error) { sendJson(ws, { type: `group_message_${state}_failed`, groupId, message: error.message }); }
}

module.exports = { activeMember, createGroup, changeMembers, leaveGroup, publicGroup, readChat,
  readGroup, requireAdmin, requireMember, sendGroupMessage, markGroupMessages, setRole, updateGroup };
