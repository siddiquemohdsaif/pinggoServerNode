const express = require('express');
const { collectPointerItem } = require('../utils/leagueHandler');
const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');

router.post('/itemCollect', async (req, res) => {
    try {
        // Extract UID the request body
        const { UID } = req.body;

        // Validate the payload
        if (!UID) {
            return res.status(400).json({
                success: false,
                message: 'all fields are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // collect league item at collect pinter
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await collectPointerItem(UID);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in league itemCollect:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


module.exports = router;
