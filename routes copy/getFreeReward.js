const express = require('express');
const UserDataModifier = require("../utils/UserDataModifier");
const AES = require("../utils/AES_256");
const userDataModifier = new UserDataModifier();
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');

router.post('/', async (req, res) => {
    try {
        const uid = req.body.UID;

        const isNewFormat =
            req.body.goldenAim != null &&
            req.body.epicAim != null &&
            req.body.legendaryAim != null;

        const isOldFormat =
            req.body.strikerId != null &&
            req.body.powerId != null &&
            req.body.puckId != null &&
            req.body.trailId != null;

        if (!uid || (!isOldFormat && !isNewFormat)) {
            return res.status(400).json({
                success: false,
                message: 'UID and valid reward parameters are required.'
            });
        }

        // Check authorization
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({
                success: false,
                message: 'Authorization failed'
            });
        }

        const updatedDocUser = await UserLock.getInstance().run(uid, async () => {
            if (isNewFormat) {
                const { goldenAim, epicAim, legendaryAim } = req.body;
                return await userDataModifier.getFreeAimReward(uid, goldenAim, epicAim, legendaryAim);
            } else {
                const { strikerId, powerId, puckId, trailId } = req.body;
                return await userDataModifier.getFreeReward(uid, strikerId, powerId, puckId, trailId);
            }
        });

        if (updatedDocUser) {
            return res.status(200).json(updatedDocUser);
        } else {
            return res.status(400).json({
                success: false,
                message: 'Unable to getFreeReward.'
            });
        }
    } catch (error) {
        console.error('Error in getFreeReward:', error.message);
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
