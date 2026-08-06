const express = require('express');
const {sendMsgToAll,sendMsgToClan,sendMsgToPlayer} = require("../utils/FCM/PushNotificationHandler")
const NotificationsHandler = require("../utils/notificationsHandler");


const AES = require("../utils/AES_256");
const router = express.Router();

router.post('/updateFCMToken', async (req, res) => {
    try {
        const uid = req.body.UID;
        const token = req.body.token;

        if (uid == null || token == null) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }

        if(token.length < 0 && token.length < 300){
            return res.status(400).json({ success: false, message: 'bad token' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        await NotificationsHandler.updateFCMToken(uid, token);

        return res.status(200).json({ success: true, message: "updated" });
    } catch (error) {
        console.error("Error in updateFCMToken:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/sendMsgToPlayer',async (req,res)=>{

    try{
        const body = JSON.stringify(req.body.body);
        const title = req.body.title;
        const receiverUID = req.body.receiverUID;

        if (body == null || title == null || receiverUID == null ) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }

        await sendMsgToPlayer(body,title,receiverUID);
        return res.status(200).json({ success: true, message: "Notification sent" });
    } catch(error){
        console.error("Error in sendMsgToPlayer:",error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/sendMsgToClan',async (req,res)=>{
    try{
        const body = JSON.stringify(req.body.body);
        const title = req.body.title;
        const clanId = req.body.clanId;

        if (body == null || title == null || clanId == null ) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }
        
        await sendMsgToClan(body,title,clanId);
        return res.status(200).json({ success: true, message: "Notification sent" });
    } catch(error){
        console.error("Error in sendMsgToClan:",error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/sendMsgToAll',async (req,res)=>{
    try{
        const body = JSON.stringify(req.body.body);
        const title = req.body.title;

        if (body == null || title == null ) {
            return res.status(400).json({ success: false, message: 'all params are required.' });
        }


        await sendMsgToAll(body,title);
        return res.status(200).json({ success: true, message: "Notification sent" });
    } catch(error){
        console.error("Error in sendMsgToAll:",error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;