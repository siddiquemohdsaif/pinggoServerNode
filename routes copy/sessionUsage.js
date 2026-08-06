const express = require('express');
const AnalyticsHandler = require("../utils/AnalyticsHandler");
const AES = require("../utils/AES_256");
const analyticsHandler = new AnalyticsHandler();
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');

router.post('/', async (req, res) => {
    try {
        const uid = req.body.UID;
        const sessionUsage = req.body.sessionUsage;

        if (uid == null || sessionUsage == null) {
            return res.status(400).json({ success: false, message: 'UID and Other Data are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const updatedDocUser = await UserLock.getInstance().run(uid, async () => {
            return await analyticsHandler.sessionUsage(uid, sessionUsage);
        });


        if (updatedDocUser) {
            return res.status(200).json(updatedDocUser);
        } else {
            return res.status(400).json({ success: false, message: "Unable to update sessionUsage." });
        }
    } catch (error) {
        console.error("Error in sessionUsage:UID "+req.body.UID, error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});
module.exports = router;