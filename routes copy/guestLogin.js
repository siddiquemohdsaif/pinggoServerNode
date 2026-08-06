const express = require('express');
const FirestoreManager = require("../Firestore/FirestoreManager");
const UserModel = require("../models/UserModel");
const AES = require("../utils/AES_256");
const { generateRandomString_Aa0, generateRandomString_a, generateCC_ID, createCC_ID_DOC, createUserInitialData } = require("../utils/guestUtils");
const ABTestingCore = require('../utils/ABTesting/ABTestingCore');
const MatchMakingEvalData = require('../utils/StaticDocument/Data/MatchMakingEvalData');

const firestoreManager = FirestoreManager.getInstance();
const router = express.Router();
require('dotenv').config();

router.get('/', async (req, res) => {
  await login(req, res);
});

router.post('/', async (req, res) => {
  await login(req, res);
});

const login = async (req, res) => {
  let deviceId = req.body.deviceId;

  if (deviceId == null || !deviceId) {
    deviceId = "null";
  }
  const uid = generateRandomString_Aa0(16);
  const loginAuth = `guest_${uid}`;
  let cc_id;
  try {
    cc_id = await generateCC_ID();
    await createCC_ID_DOC(cc_id, uid);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
  let profileData = {
    userPicture: { avatar: '0', frame: 0, loginPhotoUrl: "null" },
    userName: `guest_${generateRandomString_a(4)}`,
    nameChangeCount: 0,
    clanId: 'null',
    cc_id: cc_id,
    totalWinning: 0,
    highestTrophy: 0,
    gameWon: 0,
    gamePlay: 0,
    bestWinStrike: 0,
    currentWinStrike: 0,
    runningTutorial: 0,
    isrewardClaimed: false,
    powerMeter: 0,
    lastLevelLeagueAnim: { "level": 1, "league": 0, "returnLeagueUp": 0 }
  };


  const luckyShotsDoc = await firestoreManager.readDocument("Data", "LuckyShot", "/");
  const level = luckyShotsDoc.level1;
  const randomIndex = Math.floor(Math.random() * level.length);
  const randomShot = level[randomIndex];



  const striker = { id: 0, level: 1, collected: 0 };
  const puck = { id: 0, level: 1, collected: 0 };
  const power = { id: 0, level: 1, collected: 0 };
  const trail = { id: 0, level: 1, collected: 0 };
  const aim = { selected: 0 };
  const OnedayInMillis = 86400 * 1000;
  const ThreeHoursInMillis = 10800 * 1000;
  const halfHoursInMillis = 1800 * 1000;

  const chestData = {
    freeChestLastOpen: { SILVER_CHEST: Date.now(), GOLDEN_CHEST: Date.now(), EPIC_CHEST: Date.now(), LEGENDARY_CHEST: Date.now() },
    freeChests: [
      null,
      null,
      null,
      null
    ],
    clanWarChest: null,
    currentOpenChest: null,
    isFirstTimeChest: true
  };

  const carromPass = {
    isPremiumMember: false,
    carromPoints: 0,
    lastAnimationPointer: 0,
    collectedFree: [],
    collectedPremium: []
  }

  const leagueData = {
    collectPointer: {
      league: 1,
      tier: 1,
      item: 0
    }
  }

  function getNextDayTimestampKolkata() {
    // Get the current date and time in the Asia/Kolkata timezone
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

    // Create a new Date object for the next day in the Kolkata timezone
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

    // Adjust the nextDay timestamp to match the intended midnight IST
    return nextDay.getTime() - nextDay.getTimezoneOffset() * 60 * 1000;
  }

  const matchMakingEvalData = await MatchMakingEvalData.getMatchMakingEvalData();
  const { MatchMakingSetting } = matchMakingEvalData;

  const gameData = {
    xp: { x: 1, y: 0, z: 20 },
    trophy: 0,
    gems: 100,
    coins: 6500,
    isInWar: false,
    aim: aim,
    collection: { striker, puck, power, trail },
    freeCoin: {
      lastOpen: Date.now() - (ThreeHoursInMillis - halfHoursInMillis), nextAdRewardCollect: getNextDayTimestampKolkata(), duration: 10800,
      free: {
        "reward1": {
          "type": "coins",
          "reward": 1000
        },
        "reward2": {
          "type": "coins",
          "reward": 2000
        },
        "reward3": {
          "type": "coins",
          "reward": 3000
        },
        "reward4": {
          "type": "coins",
          "reward": 5000
        }
      },
      adReward: {
        "reward1": {
          "type": "coins",
          "reward": 1000
        },
        "reward2": {
          "type": "coins",
          "reward": 3000
        },
        "reward3": {
          "type": "gems",
          "reward": 5
        },
        "reward4": {
          "type": "silver_chest",
          "reward": 1
        }
      },
      collected: {
        "reward1": false,
        "reward2": false,
        "reward3": false,
        "reward4": false,
        "adReward1": false,
        "adReward2": false,
        "adReward3": false,
        "adReward4": false
      }
    },
    luckyShot: { lastOpen: (Date.now() - (OnedayInMillis - halfHoursInMillis)), goldenExtra: 0, extra: 0, duration: 86400, randomShot },
    chestData,
    carromPass,
    leagueData,
    ULA_Recorder: true,
    mmk: {
      timeWaitFactorPoints: MatchMakingSetting.startTimeWaitFactorPoints, lastBotLevel: 1
    },
    abTesting: {},
    event: [],
    lastCardRequest: Date.now(),
    gamePlayHistory: []

  };

  const UnlockData = {
    strikerUnlocked: [{ id: 0, level: 1, collected: 0 }],
    powerUnlocked: [{ id: 0, level: 1, collected: 0 }],
    puckUnlocked: [{ id: 0, level: 1, collected: 0 }],
    trailUnlocked: [{ id: 0, level: 1, collected: 0 }],
    avatarUnlocked: [{ id: 0 }, { id: 1 }, { id: 2 }],
    frameUnlocked: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
    emojiUnlocked: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }, { id: 20 }],
    aimUnlocked: [{ "id": 0, "level": 1, "collected": 0 }, { "id": 1, "level": 1, "collected": 0 }, { "id": 2, "level": 1, "collected": 0 }, { "id": 3, "level": 1, "collected": 0 }]
  };


  const userModel = new UserModel(uid, loginAuth, profileData, gameData, AES.getEncryptedCredential(uid, cc_id));

  await ABTestingCore.accountCreate(userModel);


  const notification = { friendList: [/*{uid, ts: timestamp}*/], info: "notification message history save below" };

  const analytics = {
    deviceId: deviceId,
    appOpenTime: Date.now(),
    appCloseTime: 0,
    adsShown: [],
    purchaseMade: [],
    duration_min: 0
  };


  // upload user to a database
  const collName = "Users";
  const docName = userModel.uid;
  const parentPath = "/";
  try {

    const UserDataCreateResult = await createUserInitialData(notification, userModel.uid, UnlockData, analytics);
    const createResult = await firestoreManager.createDocument(
      collName,
      docName,
      parentPath,
      userModel
    );
    return res.status(200).json({
      success: true,
      UID: docName,
      ENC: userModel.encryptedCredential
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
}

module.exports = router;
