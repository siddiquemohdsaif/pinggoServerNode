const express = require('express');
const UserDataModifier = require("../utils/UserDataModifier");
const AES = require("../utils/AES_256");
const userDataModifier = new UserDataModifier();
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');

router.post('/', async (req, res) => {
    try {
        const uid = req.body.UID;
        const type = req.body.type;
        const unit = req.body.unit;

        if (uid == null || unit == null || type == null) {
            return res.status(400).json({ success: false, message: 'UID,type and unit are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const updatedDocUser = await UserLock.getInstance().run(uid, async () => {
            return await userDataModifier.updateAdReward(uid, type, unit);
        });

        if (updatedDocUser) {
            return res.status(200).json(updatedDocUser);
        } else {
            return res.status(400).json({ success: false, message: "Unable to update AdReward." });
        }
    } catch (error) {
        console.error("Error in updateAdReward:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});
module.exports = router;
