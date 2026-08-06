const express = require('express');
const UserDataModifier = require("../utils/UserDataModifier");
const AES = require("../utils/AES_256");
const userDataModifier = new UserDataModifier();
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');

// depretiated
// router.post('/getLuckyShot', async (req, res) => { 
//     try {
//         const uid = req.body.UID;

//         if (uid == null) {
//             return res.status(400).json({ success: false, message: 'UID are required.' });
//         }

//         //check auth uid
//         if (uid !== AES.getAuthUid(req)) {
//             return res.status(401).json({ success: false, message: 'Authorization failed' });
//         }

//         const luckyShot = await userDataModifier.getLuckyShot(uid);

//         if (luckyShot) {
//             return res.status(200).json(luckyShot);
//         } else {
//             return res.status(400).json({ success: false, message: "Unable to get lucky shot." });
//         }
//     } catch (error) {
//         console.error("Error in lucky shot:", error.message);
//         return res.status(400).json({ success: false, message: error.message });
//     }
// });


router.post('/played', async (req, res) => {
    try {
        const uid = req.body.UID;
        const ringNo = req.body.ringNo;
        const isGoldenShot = req.body.isGoldenShot;


        if (!uid || !ringNo || isGoldenShot === undefined ) {
            return res.status(400).json({ success: false, message: 'all param are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const updatedProfile = await UserLock.getInstance().run(uid, async () => {
            return await userDataModifier.playedLuckyShot(uid, ringNo, isGoldenShot);
        });

        if (updatedProfile) {
            return res.status(200).json(updatedProfile);
        } else {
            return res.status(400).json({ success: false, message: "Unable to play lucky shot." });
        }
    } catch (error) {
        console.error("Error in lucky shot play:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


module.exports = router;