const FirestoreManager = require("../Firestore/FirestoreManager");
const getFirebaseAdmin = require("../Firebase/firebaseAdmin");
const { getFcmRegistration, getPrimaryFcmTokens } = require("../models/DeviceStore");

const firestoreManager = FirestoreManager.getInstance();

async function sendOfflineMessageNotification({ receiverId, message, group }) {
  if (await isNotificationMuted(receiverId, message.chatId)) {
    return {
      success: false,
      skipped: true,
      reason: "Chat notifications are muted.",
    };
  }
  const fcmTokens = await getFcmTokens(receiverId);
  if (fcmTokens.length === 0) {
    return {
      success: false,
      skipped: true,
      reason: "Receiver FCM token is not available.",
    };
  }

  const senderProfile = await getSenderProfile(message.senderId);
  const messageType = normalizeString(message.messageType) || "text";
  const attachmentUrl = messageType === "image" && message.attachment
    ? normalizeString(message.attachment.url)
    : "";
  const providerMessageIds = await sendToTokens(fcmTokens, {
    data: {
      type: "new_message",
      chatId: normalizeString(message.chatId),
      messageId: normalizeString(message.id),
      senderId: normalizeString(message.senderId),
      senderName: senderProfile.name,
      messageType,
      preview: notificationPreview(message, messageType),
      profilePhotoUrl: senderProfile.profilePhotoUrl,
      attachmentUrl,
      groupName: group ? normalizeString(group.name) : "",
      groupIcon: group ? normalizeString(group.icon) : "",
    },
    android: {
      priority: "high",
      ttl: 24 * 60 * 60 * 1000,
    },
  });

  return {
    success: true,
    providerData: { messageIds: providerMessageIds },
  };
}

async function sendCallNotification({ receiverId, call, missed = false }) {
  const fcmTokens = await getFcmTokens(receiverId);
  if (fcmTokens.length === 0) {
    console.warn(`[call-notification] phase=skipped callId=${call.callId}`
      + ` receiver=${receiverId} reason=no_fcm_token`);
    return { success: false, skipped: true, reason: "Receiver FCM token is not available." };
  }
  const callerProfile = await getSenderProfile(call.callerId);
  const providerMessageIds = await sendToTokens(fcmTokens, {
    data: {
      type: missed ? "call_missed" : "call_incoming",
      callId: normalizeString(call.callId),
      chatId: normalizeString(call.chatId),
      callerId: normalizeString(call.callerId),
      callerName: callerProfile.name,
      profilePhotoUrl: callerProfile.profilePhotoUrl,
      mediaType: call.mediaType === "video" ? "video" : "audio",
      engine: call.engine === "livekit" ? "livekit" : "legacy",
      callMode: call.conference || (Array.isArray(call.participantIds)
        && call.participantIds.length > 2) ? "group" : "direct",
      participantIds: JSON.stringify(Array.isArray(call.participantIds)
        ? call.participantIds : [call.callerId, call.receiverId].filter(Boolean)),
      offerType: normalizeString(call.offer && call.offer.type),
      offerDescription: normalizeString(call.offer && call.offer.description),
      offerDescriptionBase64: normalizeString(
        call.offer && call.offer.descriptionBase64),
    },
    android: { priority: "high", ttl: missed ? 24 * 60 * 60 * 1000 : 45 * 1000 },
  });
  console.log(`[call-notification] phase=sent callId=${call.callId}`
    + ` receiver=${receiverId} missed=${missed} tokens=${fcmTokens.length}`
    + ` providerMessages=${providerMessageIds.length}`
    + ` hasOffer=${Boolean(call.offer && (call.offer.descriptionBase64 || call.offer.description))}`);
  return { success: true, providerData: { messageIds: providerMessageIds } };
}

async function sendCallCancelledNotification({ receiverId, callId }) {
  const fcmTokens = await getFcmTokens(receiverId);
  if (fcmTokens.length === 0) return { success: false, skipped: true, reason: "Receiver FCM token is not available." };
  const providerMessageIds = await sendToTokens(fcmTokens, {
    data: {
      type: "call_cancelled",
      callId: normalizeString(callId),
    },
    android: { priority: "high", ttl: 45 * 1000 },
  });
  return { success: true, providerData: { messageIds: providerMessageIds } };
}

async function sendSessionLogoutNotification({ tokens, accountId, revokedAt, reason, message }) {
  const targets = [...new Set((tokens || []).map(normalizeString).filter(Boolean))];
  if (targets.length === 0) return { success: false, skipped: true };
  const providerMessageIds = await sendToTokens(targets, {
    data: {
      type: "account_logout",
      accountId: normalizeString(accountId),
      revokedAt: String(Number(revokedAt) || Date.now()),
      reason: normalizeString(reason) || "primary_logout",
      message: normalizeString(message),
    },
    android: { priority: "high", ttl: 60 * 1000 },
  });
  return { success: true, providerData: { messageIds: providerMessageIds } };
}

async function sendDeviceActivityNotification({ accountId, event, device, actorDeviceId }) {
  const tokens = await getPrimaryFcmTokens(accountId);
  if (tokens.length === 0) return { success: false, skipped: true };
  const data = deviceActivityData({ accountId, event, device, actorDeviceId });
  const providerMessageIds = await sendToTokens(tokens, {
    data,
    android: { priority: "high", ttl: 24 * 60 * 60 * 1000 },
  });
  return { success: true, providerData: { messageIds: providerMessageIds } };
}

function deviceActivityData({ accountId, event, device, actorDeviceId }) {
  const linked = event === "device_linked";
  const target = device || {};
  const deviceId = normalizeString(target.deviceId);
  const actor = normalizeString(actorDeviceId);
  return {
    type: linked ? "device_linked" : "device_unlinked",
    accountId: normalizeString(accountId),
    deviceId,
    deviceName: normalizeString(target.name) || "Companion device",
    reason: linked ? "linked" : (actor && actor === deviceId ? "self_logout" : "detached"),
    changedAt: String(Date.now()),
  };
}

async function isNotificationMuted(receiverId, chatId) {
  try {
    const listDoc = await firestoreManager.readDocument(
      "ChatsList", normalizeString(receiverId), "/",
    );
    const list = listDoc && listDoc.list;
    const settings = list && !Array.isArray(list) ? list[normalizeString(chatId)] : null;
    const mutedUntil = Number(settings && settings.notification_muted) || 0;
    return mutedUntil === -1 || mutedUntil > Date.now();
  } catch (_error) {
    return false;
  }
}

async function getSenderProfile(senderId) {
  try {
    const userDoc = await firestoreManager.readDocument(
      "Users", normalizeString(senderId), "/",
    );
    const profile = userDoc && userDoc.profileData ? userDoc.profileData : {};
    return {
      name: normalizeString(profile.name) || normalizeString(senderId) || "New message",
      profilePhotoUrl: normalizeString(profile.profilePhotoUrl),
    };
  } catch (_error) {
    return {
      name: normalizeString(senderId) || "New message",
      profilePhotoUrl: "",
    };
  }
}

function notificationPreview(message, messageType) {
  if (messageType === "image") return "Photo";
  if (messageType === "video") return "Video";
  if (messageType === "audio" || messageType === "voice") return "Voice message";
  if (messageType === "file" || messageType === "document") return "Document";
  const text = normalizeString(message.text) || "New message";
  return text.length > 500 ? text.substring(0, 500) : text;
}

async function getLegacyFcmToken(receiverId) {
  try {
    const userDoc = await firestoreManager.readDocument("Users", receiverId, "/");
    if (!userDoc) {
      return "";
    }

    return normalizeString(
      userDoc.fcmToken ||
        userDoc.deviceToken ||
        (userDoc.profileData && userDoc.profileData.fcmToken) ||
        (userDoc.profileData && userDoc.profileData.deviceToken),
    );
  } catch (error) {
    return "";
  }
}

async function getFcmTokens(receiverId) {
  const registration = await getFcmRegistration(receiverId)
    .catch(() => ({ registryExists: false, tokens: [] }));
  // Once an account has migrated to the device registry, an empty token set
  // means every installation was revoked. Falling back would resurrect a stale
  // legacy token and leak old-account notifications to a switched device.
  if (registration.registryExists) return registration.tokens;
  const legacy = await getLegacyFcmToken(receiverId);
  return legacy ? [legacy] : [];
}

async function sendToTokens(tokens, message) {
  const messaging = getFirebaseAdmin().messaging();
  const results = await Promise.allSettled(tokens.map((token) =>
    messaging.send({ ...message, token })));
  const ids = results.filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (ids.length === 0) {
    const failure = results.find((result) => result.status === "rejected");
    throw (failure ? failure.reason : new Error("No notification target accepted the message."));
  }
  return ids;
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

module.exports = {
  sendOfflineMessageNotification,
  sendCallNotification,
  sendCallCancelledNotification,
  sendSessionLogoutNotification,
  sendDeviceActivityNotification,
  deviceActivityData,
};
