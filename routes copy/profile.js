const express = require('express');
const { deleteAccountProcessInitiate, cancelAccountDeletionProcess, deleteAccount } = require('../utils/AccountDeleteHandler');
const { clearAllNotification } = require('../utils/notificationsHandler');

const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');

// Route to initiate account deletion process
router.post('/deleteAccountProcessInitiate', async (req, res) => {
    try {
        const { UID } = req.body;

        if (!UID) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await deleteAccountProcessInitiate(UID);
        });

        tempDelayDeleteAccout(UID);

        return res.status(200).json(profileData);
    } catch (error) {
        console.error("Error in deleteAccountProcessInitiate:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Route to cancel account deletion process
router.post('/cancelAccountDeletionProcess', async (req, res) => {
    try {
        const { UID } = req.body;

        if (!UID) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await cancelAccountDeletionProcess(UID);
        });

        return res.status(200).json(profileData);
    } catch (error) {
        console.error("Error in cancelAccountDeletionProcess:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Route to delete account
router.post('/deleteAccountCommandFromServer', async (req, res) => {
    try {
        const { UID } = req.body;

        if (!UID) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await deleteAccount(UID);
        });

        return res.status(200).json(profileData);
    } catch (error) {
        console.error("Error in deleteAccount:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

//temp 
const tempDelayDeleteAccout = async (uid) => {
    const delay = 1000 * 600; // 10 minutes
    setTimeout(() => deleteAccount(uid), delay);
}




// Route to cancel account deletion process
router.post('/clearNotificationList', async (req, res) => {
    try {
        const { UID } = req.body;

        if (!UID) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const result = await clearAllNotification(UID);

        return res.status(200).json(result);
    } catch (error) {
        console.error("Error in clearAllNotification:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
