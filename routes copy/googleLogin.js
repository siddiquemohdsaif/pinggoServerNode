const express = require('express');
const AES = require("../utils/AES_256");
const { verify, getGoogleAccount, createNewGoogleAuthAccount } = require("../utils/googleUtils");
const UserLock = require('../utils/Lock/UserLock');

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        const UID  = req.body.UID;
        const ENC  = req.body.ENC;

        //AUTH verification
        if(!AES.validateEncryptedCredentialByUID(ENC,UID)){                 
            console.error("Error in loginAsGoogle:", "Not valid");
            return res.status(400).json({ success: false, message: "Not valid" });
        }

        const existingGoogleAccount = await getGoogleAccount(req.body.idToken, UID);
        if (existingGoogleAccount) {
            return res.status(200).json({ success: true, UID: existingGoogleAccount.UID , ENC : existingGoogleAccount.ENC });
        } else {

            const newGoogleAuthAccount = await UserLock.getInstance().run(UID, async () => {
                return await createNewGoogleAuthAccount(req.body.idToken, UID , ENC);
            });
            
            if (newGoogleAuthAccount) {
                return res.status(200).json({ success: true, UID: UID , ENC : ENC });
            } else {
                return res.status(400).json({ success: false, message: "Unable to create new Google Auth account." });
            }
        }
    } catch (error) {
        console.error("Error in loginAsGoogle:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;
