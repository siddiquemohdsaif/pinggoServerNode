const { WebSocket, WebSocketServer } = require("ws");
const AES = require("../utils/AES_256");
const {
  addUser,
  removeUser,
  getOnlineUserCount,
} = require("./connectionManager");
const {
  handleDeleteMessage,
  handleDeleteOpponentMessage,
  handleDeliveredMessage,
  handleEditMessage,
  handleSeenMessage,
  handleSendMessage,
} = require("./messageHandler");
const {
  handleTypingEvent,
  markUserOffline,
  markUserOnline,
  notifyPresenceToContacts,
} = require("./presenceService");

function createWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const remoteAddress = req.socket.remoteAddress;
    ws.authorization = req.headers.authorization || "";
    console.log(`WebSocket connected: ${remoteAddress}`);

    ws.send(
      JSON.stringify({
        type: "connection_ready",
        message: "WebSocket connected. Send auth event next.",
      }),
    );

    ws.on("message", (rawMessage) => {
      handleMessage(ws, rawMessage).catch((error) => {
        console.error("WebSocket message error:", error.message);
        sendJson(ws, {
          type: "error",
          message: "Unable to process WebSocket message.",
        });
      });
    });

    ws.on("close", () => {
      removeUser(ws.userId, ws);
      handleDisconnect(ws).catch((error) => {
        console.error("WebSocket disconnect error:", error.message);
      });
      console.log(`WebSocket disconnected: ${remoteAddress}`);
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error.message);
    });
  });

  console.log("WebSocket server is ready on /ws");
  return wss;
}

async function handleMessage(ws, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch (error) {
    sendJson(ws, {
      type: "error",
      message: "Invalid JSON message.",
    });
    return;
  }

  if (!message.type) {
    sendJson(ws, {
      type: "error",
      message: "Message type is required.",
    });
    return;
  }

  if (message.type === "auth") {
    await handleAuth(ws, message);
    return;
  }

  if (!ws.isAuthenticated) {
    sendJson(ws, {
      type: "auth_required",
      message: "Send auth event before other WebSocket events.",
    });
    return;
  }

  if (message.type === "send_message") {
    await handleSendMessage(ws, message, sendJson);
    return;
  }

  if (message.type === "edit_message") {
    await handleEditMessage(ws, message, sendJson);
    return;
  }

  if (message.type === "delete_message") {
    await handleDeleteMessage(ws, message, sendJson);
    return;
  }

  if (message.type === "delete_opponent_message") {
    await handleDeleteOpponentMessage(ws, message, sendJson);
    return;
  }

  if (message.type === "message_seen") {
    await handleSeenMessage(ws, message, sendJson);
    return;
  }

  if (message.type === "message_delivered") {
    await handleDeliveredMessage(ws, message, sendJson);
    return;
  }

  if (message.type === "typing_start" || message.type === "typing_stop") {
    await handleTypingEvent(ws, message, sendJson, message.type);
    return;
  }

  sendJson(ws, {
    type: "event_received",
    receivedType: message.type,
  });
}

async function handleAuth(ws, message) {
  const credentials = getAuthCredentials(ws, message);

  if (!credentials.userId || !credentials.encryptedCredential) {
    sendJson(ws, {
      type: "auth_failed",
      message: "userId/phoneNumber and encryptedCredential are required.",
    });
    ws.close(4001, "Authentication failed.");
    return;
  }

  if (
    !AES.validateEncryptedCredentialByUID(
      credentials.encryptedCredential,
      credentials.userId,
    )
  ) {
    sendJson(ws, {
      type: "auth_failed",
      message: "Invalid encrypted credential.",
    });
    ws.close(4001, "Authentication failed.");
    return;
  }

  addUser(credentials.userId, ws);
  await markUserOnline(credentials.userId);
  sendJson(ws, {
    type: "auth_success",
    userId: credentials.userId,
    onlineUserCount: getOnlineUserCount(),
  });
  await notifyPresenceToContacts(
    credentials.userId,
    {
      type: "online_status",
      userId: credentials.userId,
      isOnline: true,
      lastSeen: Date.now(),
    },
    sendJson,
  );
}

async function handleDisconnect(ws) {
  const userId = ws.userId;
  if (!userId || !ws.isAuthenticated) {
    return;
  }

  const lastSeen = await markUserOffline(userId);
  await notifyPresenceToContacts(
    userId,
    {
      type: "online_status",
      userId,
      isOnline: false,
      lastSeen,
    },
    sendJson,
  );
}

function getAuthCredentials(ws, message) {
  const tokenCredentials = parseAuthorizationToken(
    message.authorization || message.token || ws.authorization,
  );
  if (tokenCredentials.userId && tokenCredentials.encryptedCredential) {
    return tokenCredentials;
  }

  return {
    userId: normalizeAccountId(
      message.userId || message.uid || message.phoneNumber || message.phone,
    ),
    encryptedCredential:
      normalizeString(message.encryptedCredential) ||
      normalizeString(message.credential),
  };
}

function parseAuthorizationToken(value) {
  const token = normalizeString(value).replace(/^Bearer\s+/i, "");
  if (!token) {
    return {};
  }

  const separatorIndex = token.indexOf("_");
  if (separatorIndex < 1) {
    return {};
  }

  return {
    userId: normalizeAccountId(token.slice(0, separatorIndex)),
    encryptedCredential: token.slice(separatorIndex + 1),
  };
}

function normalizeAccountId(value) {
  return normalizeString(value).replace(/^<plus>/, "").replace(/^\+/, "");
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

module.exports = {
  createWebSocketServer,
};
