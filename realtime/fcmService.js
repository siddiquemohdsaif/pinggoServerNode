const FirestoreManager = require("../Firestore/FirestoreManager");
const getFirebaseAdmin = require("../Firebase/firebaseAdmin");

const firestoreManager = FirestoreManager.getInstance();

async function sendOfflineMessageNotification({ receiverId, message, group }) {
  if (await isNotificationMuted(receiverId, message.chatId)) {
    return {
      success: false,
      skipped: true,
      reason: "Chat notifications are muted.",
    };
  }
  const fcmToken = await getFcmToken(receiverId);
  if (!fcmToken) {
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
  const providerMessageId = await getFirebaseAdmin().messaging().send({
    token: fcmToken,
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
    providerData: { messageId: providerMessageId },
  };
}

async function sendCallNotification({ receiverId, call, missed = false }) {
  const fcmToken = await getFcmToken(receiverId);
  if (!fcmToken) return { success: false, skipped: true, reason: "Receiver FCM token is not available." };
  const callerProfile = await getSenderProfile(call.callerId);
  const providerMessageId = await getFirebaseAdmin().messaging().send({
    token: fcmToken,
    data: {
      type: missed ? "call_missed" : "call_incoming",
      callId: normalizeString(call.callId),
      chatId: normalizeString(call.chatId),
      callerId: normalizeString(call.callerId),
      callerName: callerProfile.name,
      profilePhotoUrl: callerProfile.profilePhotoUrl,
      mediaType: call.mediaType === "video" ? "video" : "audio",
    },
    android: { priority: "high", ttl: missed ? 24 * 60 * 60 * 1000 : 45 * 1000 },
  });
  return { success: true, providerData: { messageId: providerMessageId } };
}

async function sendCallCancelledNotification({ receiverId, callId }) {
  const fcmToken = await getFcmToken(receiverId);
  if (!fcmToken) return { success: false, skipped: true, reason: "Receiver FCM token is not available." };
  const providerMessageId = await getFirebaseAdmin().messaging().send({
    token: fcmToken,
    data: {
      type: "call_cancelled",
      callId: normalizeString(callId),
    },
    android: { priority: "high", ttl: 45 * 1000 },
  });
  return { success: true, providerData: { messageId: providerMessageId } };
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

async function getFcmToken(receiverId) {
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
};
