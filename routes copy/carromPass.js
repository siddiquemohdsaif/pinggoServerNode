const express = require('express');
const { collectItemAtIndex, updateLastAnimationPointer} = require('../utils/carromPassHandler');
const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');


router.post('/itemCollect', async (req, res) => {
    try {
        // Extract UID and itemIndex from the request body
        const { UID, itemIndex, isPremiumMemberIndex } = req.body;

        // Validate the payload
        if (!UID || itemIndex === undefined || isPremiumMemberIndex === undefined) {
            return res.status(400).json({
                success: false,
                message: 'all fields are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // collect carrompass item at index itemIndex
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await collectItemAtIndex(UID, itemIndex, isPremiumMemberIndex);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in carromPass itemCollect:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


router.post('/updateLastAnimationPointer', async (req, res) => {
    try {
        // Extract UID and newAnimationPointer from the request body
        const { UID, newAnimationPointer } = req.body;

        // Validate the payload
        if (!UID || newAnimationPointer === undefined) {
            return res.status(400).json({
                success: false,
                message: 'all fields are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Update the lastAnimationPointer for the given UID
        const updatedProfileData = await UserLock.getInstance().run(UID, async () => {
            return await updateLastAnimationPointer(UID, newAnimationPointer);
        });


        // Respond with the updated profile data
        return res.status(200).json(updatedProfileData);
        
    } catch (error) {
        console.error("Error in updateLastAnimationPointer:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


module.exports = router;
