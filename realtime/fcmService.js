const axios = require("axios");
const FirestoreManager = require("../Firestore/FirestoreManager");

const firestoreManager = FirestoreManager.getInstance();
const FCM_LEGACY_SEND_URL = "https://fcm.googleapis.com/fcm/send";

async function sendOfflineMessageNotification({ receiverId, message }) {
  const serverKey = normalizeString(process.env.FCM_SERVER_KEY);
  if (!serverKey) {
    return {
      success: false,
      skipped: true,
      reason: "FCM_SERVER_KEY is not configured.",
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

  const response = await axios.post(
    FCM_LEGACY_SEND_URL,
    {
      to: fcmToken,
      priority: "high",
      data: {
        type: "new_message",
        chatId: message.chatId,
        messageId: message.id,
        senderId: message.senderId,
        receiverId: message.receiverId,
        sentTime: String(message.sentTime),
      },
      notification: {
        title: "New message",
        body: message.text,
      },
    },
    {
      headers: {
        Authorization: `key=${serverKey}`,
        "Content-Type": "application/json",
      },
    },
  );

  return {
    success: response.data && response.data.success > 0,
    providerData: response.data,
  };
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
};
