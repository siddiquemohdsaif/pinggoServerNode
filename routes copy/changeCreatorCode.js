const express = require('express');
const UserDataModifier = require("../utils/UserDataModifier");
const AES = require("../utils/AES_256");
const userDataModifier = new UserDataModifier();
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');

router.post('/add', async (req, res) => {
    try {
        const uid = req.body.UID;
        const creatorCode = req.body.creatorCode;
        
        if(uid == null || creatorCode == null){
            return res.status(400).json({ success: false, message: 'UID and creatorCode are required.' });
        }

        //check auth uid
        if(uid !== AES.getAuthUid(req)){
            return res.status(401).json({ success: false, message: 'Authorization failed'});
        }

        const updatedDocUser = await UserLock.getInstance().run(uid, async () => {
            return await userDataModifier.addCreatorCode(uid, creatorCode);
        });

        if (updatedDocUser) {
            return res.status(200).json(updatedDocUser);
        } else {
            return res.status(400).json({ success: false, message: "Unable to add creatorCode." });
        }
    } catch (error) {
        console.error("Error in add creatorCode:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/remove', async (req, res) => {
    try {
        const uid = req.body.UID;
        
        if(uid == null){
            return res.status(400).json({ success: false, message: 'UID and creatorCode are required.' });
        }

        //check auth uid
        if(uid !== AES.getAuthUid(req)){
            return res.status(401).json({ success: false, message: 'Authorization failed'});
        }

        const updatedDocUser = await UserLock.getInstance().run(uid, async () => {
            return await userDataModifier.removeCreatorCode(uid);
        });

        if (updatedDocUser) {
            return res.status(200).json(updatedDocUser);
        } else {
            return res.status(400).json({ success: false, message: "Unable to remove creatorCode." });
        }
    } catch (error) {
        console.error("Error in remove creatorCode:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;
