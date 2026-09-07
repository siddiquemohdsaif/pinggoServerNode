const { applicationDefault, getApps, initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

function getFirebaseAdmin() {
  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
    });
  }
  return {
    messaging: () => getMessaging(),
  };
}

module.exports = getFirebaseAdmin;
