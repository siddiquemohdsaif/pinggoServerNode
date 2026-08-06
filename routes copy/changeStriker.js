const express = require('express');
const UserDataModifier = require("../utils/UserDataModifier");
const AES = require("../utils/AES_256");
const userDataModifier = new UserDataModifier();
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');

router.post('/', async (req, res) => {
    try {
        const uid = req.body.UID;
        const strikerId = req.body.strikerId;

        if (uid == null || strikerId == null) {
            return res.status(400).json({ success: false, message: 'UID and StrikerID are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const updatedDocUser = await UserLock.getInstance().run(uid, async () => {
            return await userDataModifier.updateStriker(uid, strikerId);
        });

        if (updatedDocUser) {
            return res.status(200).json(updatedDocUser);
        } else {
            return res.status(400).json({ success: false, message: "Unable to update striker." });
        }
    } catch (error) {
        console.error("Error in changeStriker:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});
module.exports = router;
