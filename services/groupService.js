const crypto = require("crypto");
const FirestoreManager = require("../Firestore/FirestoreManager");
const { getUserSockets, isUserOnline, isUserViewingChat } = require("../realtime/connectionManager");
const { nextTimestamp } = require("../utils/timestampId");
const { forStorage } = require("../utils/messageTypes");
const { sendOfflineMessageNotification } = require("../realtime/fcmService");
const { ensureShardedContainer, readShardedMap, upsertShardedEntries } = require("../models/ShardedDocumentStore");
const { ensureAccountCollections } = require("../models/AccountStore");
const { readAttachment, updateAttachment } = require("../models/ChatAttachmentStore");
const { getJson, setJson, remove } = require("./redisStore");
const { enqueue } = require("./retryQueue");

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
function membershipPeriods(member) {
  if (!member) return [];
  if (Array.isArray(member.membershipPeriods) && member.membershipPeriods.length) {
    return member.membershipPeriods.filter((period) => period && Number(period.joinedAt) > 0)
      .map((period) => ({ joinedAt: Number(period.joinedAt),
        leftAt: period.leftAt == null ? null : Number(period.leftAt) }));
  }
  return Number(member.joinedAt) > 0
    ? [{ joinedAt: Number(member.joinedAt),
      leftAt: member.leftAt == null ? null : Number(member.leftAt) }]
    : [];
}
function memberCanAccessAt(member, timestamp) {
  const at = Number(timestamp);
  return Number.isFinite(at) && membershipPeriods(member).some((period) =>
    at >= period.joinedAt && (period.leftAt == null || at < period.leftAt));
}
function memberCanAccessMessage(member, userId, message) {
  if (!message) return false;
  if (memberCanAccessAt(member, message.sentTime)) return true;
  const event = message.systemEvent;
  if (!event || !["members_added", "members_removed", "member_left"].includes(event.event)) {
    return false;
  }
  const id = accountId(userId);
  return Array.isArray(event.targetIds) && event.targetIds.some((target) => accountId(target) === id);
}
function isAdmin(group, userId) { return activeMember(group, userId)?.role === "admin"; }
function ownerId(group) {
  if (!group) return "";
  const explicitOwnerId = accountId(group.ownerId);
  if (explicitOwnerId && activeMember(group, explicitOwnerId)?.role === "admin") {
    return explicitOwnerId;
  }
  const creatorId = accountId(group.createdBy);
  if (creatorId && activeMember(group, creatorId)?.role === "admin") return creatorId;
  const successor = Object.values(group.members || {}).filter((member) =>
    member.status === "active" && member.role === "admin")
    .sort((a, b) => Number(a.joinedAt || 0) - Number(b.joinedAt || 0))[0];
  return successor ? accountId(successor.userId) : "";
}
function publicGroup(group) {
  if (!group) return null;
  return { ...withoutId(group), ownerId: ownerId(group),
    members: Object.values(group.members || {}) };
}
async function readGroup(groupId) {
  const id = text(groupId);
  const key = `pinggo:cache:group:${id}`;
  try {
    const cached = await getJson(key);
    if (cached) return cached;
    const group = await firestore.readDocument("GroupsList", id, "/");
    if (group) await setJson(key, group, 30);
    return group;
  }
  catch (_error) { return null; }
}
async function writeGroup(group) {
  const stored = withoutId(group);
  let result;
  try { result = await firestore.updateDocument("GroupsList", group.groupId, "/", stored); }
  catch (_error) { result = await firestore.createDocument("GroupsList", group.groupId, "/", stored); }
  await remove(`pinggo:cache:group:${group.groupId}`);
  return result;
}
async function readChat(groupId) {
  try { return await readShardedMap("GroupsChat", groupId); }
  catch (_error) { return null; }
}
async function ensureChat(groupId) {
  await ensureShardedContainer("GroupsChat", groupId, "messages");
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
  await ensureAccountCollections(userId);
  await mutateChatList(userId, (list) => {
    list[group.groupId] = { ...defaultChatSettings(group), ...(list[group.groupId] || {}),
      chat_type: "group", group_id: group.groupId, group_name: group.name, group_icon: group.icon || null };
  });
}
async function updateListMetadata(group) {
  await Promise.all(Object.values(group.members || {}).filter((m) => m.status === "active")
    .map((m) => addToChatList(m.userId, group)));
}
async function retainRemovedChat(userId, group, message) {
  await mutateChatList(userId, (list) => {
    list[group.groupId] = { ...defaultChatSettings(group), ...(list[group.groupId] || {}),
      last_message: forStorage(message), unread_count: 0, membership_active: false };
  });
}
function send(userId, payload) {
  getUserSockets(accountId(userId)).forEach((socket) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(payload));
  });
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
  await upsertShardedEntries("GroupsChat", group.groupId, { [message.id]: forStorage(message) });
  await fanOutMessage(group, message, actorId);
  return message;
}
async function fanOutMessage(group, message, senderId) {
  const members = Object.values(group.members || {}).filter((m) => m.status === "active");
  const transportMessage = forStorage(message);
  await Promise.all(members.map((m) => mutateChatList(m.userId, (list) => {
    const settings = { ...defaultChatSettings(group), ...(list[group.groupId] || {}) };
    settings.last_message = transportMessage;
    if (m.userId !== accountId(senderId) && !isUserViewingChat(m.userId, group.groupId)) {
      settings.unread_count = (Number(settings.unread_count) || 0) + 1;
    }
    list[group.groupId] = settings;
  })));
  members.forEach((m) => {
    send(m.userId, { type: "new_group_message", message: transportMessage, groupName: group.name,
      groupIcon: group.icon || null });
    if (m.userId !== accountId(senderId) && !isUserOnline(accountId(m.userId))) {
      sendOfflineMessageNotification({ receiverId: m.userId, message, group })
        .catch(async (error) => {
          console.error("Could not send group notification:", error.message);
          await enqueue("offline-message-notification", {
            receiverId: m.userId, message: forStorage(message), group: publicGroup(group) });
        });
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
    leftAt: null, addedBy: creatorId, membershipPeriods: [{ joinedAt: now, leftAt: null }] }]));
  const group = { groupId, name: name.slice(0, 100), description: text(description).slice(0, 2048),
    icon: text(icon) || null, createdBy: creatorId, ownerId: creatorId, createdAt: now, updatedAt: now,
    membershipVersion: 1, permissions: { sendMessages: "members", editInfo: "admins",
      startCalls: "members", addMembers: "admins", approveMembers: "admins" }, members, invite: null };
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
  if (action === "remove" && ids.some((id) => activeMember(group, id)?.role === "admin")) {
    const error = new Error("A group admin cannot be removed.");
    error.statusCode = 409; throw error;
  }
  const activeCount = Object.values(group.members || {}).filter((m) => m.status === "active").length;
  if (action === "add" && activeCount + ids.filter((id) => !activeMember(group, id)).length > MAX_MEMBERS) throw new Error("Group capacity exceeded.");
  const now = Date.now();
  for (const id of ids) {
    const existing = group.members[id];
    if (action === "add") {
      if (activeMember(group, id)) continue;
      group.members[id] = { ...(existing || {}), userId: id, role: "member", status: "active",
        joinedAt: now, leftAt: null, addedBy: accountId(actorId),
        membershipPeriods: [...membershipPeriods(existing), { joinedAt: now, leftAt: null }] };
    } else if (activeMember(group, id)) {
      const periods = membershipPeriods(existing);
      if (periods.length) periods[periods.length - 1].leftAt = now;
      group.members[id] = { ...existing, status: "removed", leftAt: now,
        removedBy: accountId(actorId), membershipPeriods: periods };
    }
  }
  group.updatedAt = now; group.membershipVersion = (group.membershipVersion || 0) + 1;
  await writeGroup(group);
  if (action === "add") await Promise.all(ids.map((id) => addToChatList(id, group)));
  const membershipMessage = await systemMessage(
    group, actorId, action === "add" ? "members_added" : "members_removed", ids);
  if (action === "remove") {
    await Promise.all(ids.map((id) => retainRemovedChat(id, group, membershipMessage)));
  }
  ids.forEach((id) => send(id, { type: action === "add" ? "group_added" : "group_removed", groupId,
    affectedUserId: id,
    message: forStorage(membershipMessage),
    group: action === "add" ? publicGroup(group) : undefined }));
  broadcast(group, { type: "group_updated", group: publicGroup(group) });
  return group;
}

async function leaveGroup(groupId, userId, successorAdminId) {
  const group = await readGroup(groupId); requireMember(group, userId);
  const id = accountId(userId); const now = Date.now();
  const wasAdmin = isAdmin(group, id);
  let promotedSuccessorId = null;
  const otherAdmins = Object.values(group.members).filter((m) =>
    m.status === "active" && m.role === "admin" && m.userId !== id);
  if (wasAdmin && !otherAdmins.length) {
    const successorId = accountId(successorAdminId);
    const successor = activeMember(group, successorId);
    if (!successor || successorId === id) {
      const error = new Error("Choose an active member to become admin before exiting.");
      error.statusCode = 409; error.code = "SUCCESSOR_ADMIN_REQUIRED"; throw error;
    }
    group.members[successorId] = { ...successor, role: "admin", promotedAt: now,
      roleChangedBy: id };
    promotedSuccessorId = successorId;
  }
  if (ownerId(group) === id) {
    const nextOwnerId = promotedSuccessorId || (otherAdmins[0] && otherAdmins[0].userId);
    if (!nextOwnerId) {
      const error = new Error("Choose an active member to become admin before exiting.");
      error.statusCode = 409; error.code = "SUCCESSOR_ADMIN_REQUIRED"; throw error;
    }
    group.ownerId = accountId(nextOwnerId);
  }
  group.members[id] = { ...group.members[id], status: "left", leftAt: now };
  const periods = membershipPeriods(group.members[id]);
  if (periods.length) periods[periods.length - 1].leftAt = now;
  group.members[id].membershipPeriods = periods;
  group.updatedAt = now; group.membershipVersion = (group.membershipVersion || 0) + 1;
  await writeGroup(group);
  if (promotedSuccessorId) {
    await systemMessage(group, id, "admin_promoted", [promotedSuccessorId]);
  }
  const leaveMessage = await systemMessage(group, id, "member_left", [id]);
  await retainRemovedChat(id, group, leaveMessage);
  // The normal fan-out contains active members only. Deliver the final system pill explicitly
  // so the member who just left sees the same event in the still-open conversation.
  send(id, { type: "group_left", groupId, affectedUserId: id,
    message: forStorage(leaveMessage) });
  broadcast(group, { type: "group_updated", group: publicGroup(group) });
  return group;
}

async function removeDeletedAccount(groupId, userId) {
  const group = await readGroup(groupId);
  const id = accountId(userId);
  const member = activeMember(group, id);
  if (!member) return null;
  const now = Date.now();
  const others = Object.values(group.members || {}).filter((m) =>
    m && m.userId !== id && m.status === "active");
  if (ownerId(group) === id) {
    const successor = others.find((m) => m.role === "admin") || others[0];
    group.ownerId = successor ? successor.userId : "";
    if (successor) group.members[successor.userId] = { ...successor, role: "admin",
      promotedAt: now, roleChangedBy: id };
  }
  // Persist/fan out the timeline pill while the remaining membership is still authoritative.
  const leaveMessage = await systemMessage(group, id, "member_left", [id],
    { deletedAccount: true });
  group.members[id] = { ...member, status: "deleted", leftAt: now, profilePhotoUrl: null };
  const periods = membershipPeriods(group.members[id]);
  if (periods.length) periods[periods.length - 1].leftAt = now;
  group.members[id].membershipPeriods = periods;
  group.updatedAt = now;
  group.membershipVersion = Number(group.membershipVersion || 0) + 1;
  await writeGroup(group);
  broadcast(group, { type: "group_updated", group: publicGroup(group) });
  return { message: leaveMessage, memberIds: others.map((m) => m.userId) };
}

async function setRole(groupId, actorId, memberId, role) {
  const group = await readGroup(groupId); requireAdmin(group, actorId);
  const currentOwnerId = ownerId(group);
  if (currentOwnerId !== accountId(actorId)) {
    const error = new Error("Only the group owner can change administrator roles.");
    error.statusCode = 403; throw error;
  }
  group.ownerId = currentOwnerId;
  memberId = accountId(memberId); role = text(role);
  if (!activeMember(group, memberId) || !["admin", "member"].includes(role)) throw new Error("Valid active member and role are required.");
  if (memberId === currentOwnerId && role === "member") {
    const error = new Error("The group owner cannot be changed to a member.");
    error.statusCode = 409; throw error;
  }
  group.members[memberId] = { ...group.members[memberId], role, roleChangedAt: Date.now(), roleChangedBy: accountId(actorId) };
  group.updatedAt = Date.now(); await writeGroup(group);
  await systemMessage(group, actorId, role === "admin" ? "admin_promoted" : "admin_demoted", [memberId]);
  broadcast(group, { type: "group_updated", group: publicGroup(group) }); return group;
}

async function updateGroup(groupId, actorId, changes) {
  const group = await readGroup(groupId); requireAdmin(group, actorId);
  let adminOnlyChanged = null;
  if (changes.name !== undefined) { const value = text(changes.name); if (!value) throw new Error("name cannot be empty."); group.name = value.slice(0, 100); }
  if (changes.description !== undefined) group.description = text(changes.description).slice(0, 2048);
  if (changes.icon !== undefined) group.icon = text(changes.icon) || null;
  if (changes.permissions !== undefined) {
    const allowed = ["members", "admins"]; const next = { ...group.permissions };
    for (const key of ["sendMessages", "startCalls", "editInfo", "addMembers", "approveMembers"]) if (changes.permissions[key] !== undefined) {
      if (!allowed.includes(changes.permissions[key])) throw new Error(`Invalid permission: ${key}.`);
      next[key] = changes.permissions[key];
    }
    if (changes.permissions.sendMessages !== undefined) {
      const mode = changes.permissions.sendMessages;
      next.startCalls = mode;
      if (group.permissions?.sendMessages !== mode || group.permissions?.startCalls !== mode) {
        adminOnlyChanged = mode === "admins";
      }
    }
    group.permissions = next;
  }
  group.updatedAt = Date.now(); await writeGroup(group); await updateListMetadata(group);
  await systemMessage(group, actorId, adminOnlyChanged == null ? "group_info_updated"
    : adminOnlyChanged ? "admin_only_enabled" : "admin_only_disabled");
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
    const clientMessageId = text(payload.clientMessageId || payload.localMessageId);
    const idempotencyKey = `pinggo:idempotency:group-message:${senderId}:${clientMessageId}`;
    const cachedMessage = clientMessageId ? await getJson(idempotencyKey) : null;
    if (cachedMessage && cachedMessage.groupId === groupId) {
      sendJson(ws, { type: "group_message_ack", clientMessageId,
        messageId: cachedMessage.id, chatId: groupId, status: "sent",
        sentTime: cachedMessage.sentTime, message: cachedMessage });
      return;
    }
    const chat = await readChat(groupId);
    const duplicate = clientMessageId && chat && Object.values(chat).find((m) => m && m.clientMessageId === clientMessageId && accountId(m.senderId) === senderId);
    if (duplicate) { sendJson(ws, { type: "group_message_ack", clientMessageId, message: forStorage(duplicate) }); return; }
    let attachment = payload.attachment || null;
    const attachmentId = text(payload.attachmentId);
    if (!attachment && attachmentId) {
      try { attachment = await readAttachment(groupId, attachmentId); }
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
    await ensureChat(groupId); await upsertShardedEntries("GroupsChat", groupId, {
      [message.id]: forStorage(message),
    });
    if (clientMessageId) await setJson(idempotencyKey, forStorage(message), 24 * 60 * 60);
    if (attachmentId) await updateAttachment(groupId, attachmentId, {
      status: "used", messageId: message.id, usedAt: sentTime,
    });
    await fanOutMessage(group, message, senderId);
    sendJson(ws, { type: "group_message_ack", clientMessageId, messageId: message.id, chatId: groupId,
      status: "sent", sentTime, message: forStorage(message) });
  } catch (error) { sendJson(ws, { type: "group_message_failed", groupId, clientMessageId: payload.clientMessageId || null, message: error.message }); }
}

async function markGroupMessages(ws, payload, sendJson, state) {
  const groupId = text(payload.groupId || payload.chatId); const userId = accountId(ws.userId);
  try {
    const group = await readGroup(groupId); requireMember(group, userId);
    const chat = await readChat(groupId); const ids = [...new Set((payload.messageIds || []).map(text).filter(Boolean))];
    if (!ids.length) throw new Error("messageIds must be a non-empty array.");
    const at = Date.now(); const updates = {};
    const membership = group.members[userId];
    ids.forEach((id) => { const message = chat && chat[id];
      if (!message || !memberCanAccessAt(membership, message.sentTime)) return;
      const receipt = { ...((message.receipts || {})[userId] || {}) };
      if (state === "delivered") receipt.deliveredAt = receipt.deliveredAt || at;
      else { receipt.deliveredAt = receipt.deliveredAt || at; receipt.readAt = receipt.readAt || at; }
      updates[id] = { ...message, receipts: { ...(message.receipts || {}), [userId]: receipt } };
    });
    if (!Object.keys(updates).length) throw new Error("No messages found.");
    await upsertShardedEntries("GroupsChat", groupId, updates);
    if (state === "read") await mutateChatList(userId, (list) => { if (list[groupId]) list[groupId].unread_count = 0; });
    const event = { type: state === "read" ? "group_message_seen" : "group_message_delivered",
      groupId, messageIds: Object.keys(updates), userId, at };
    sendJson(ws, { ...event, type: `${event.type}_ack` }); broadcast(group, event, userId);
  } catch (error) { sendJson(ws, { type: `group_message_${state}_failed`, groupId, message: error.message }); }
}

module.exports = { activeMember, memberCanAccessAt, memberCanAccessMessage,
  createGroup, changeMembers, leaveGroup, publicGroup, readChat,
  readGroup, requireAdmin, requireMember, removeDeletedAccount, sendGroupMessage,
  markGroupMessages, setRole, updateGroup };
