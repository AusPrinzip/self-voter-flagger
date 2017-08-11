'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for');

const
  DB_RECORDS = "records",
  DB_VOTERS = "voters",
  DB_RUNS = "runs",
  DB_QUEUE = "queue",
  DB_FLAGLIST = "flaglist";

const
  VOTE_POWER_1_PC = 100,
  DATE_FORMAT = "dddd, MMMM Do YYYY, h:mm:ss a";

var
  MIN_SP = 1000;

var db;

var mAccount = null;
var mProperties = null;
var mChainInfo = null;
var mLastInfos = null;
var mTestAuthorList = null;

// Connect to the database first


function start(callback) {
  mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
    if (err) {
      console.log(err);
      process.exit(1);
    }

    db = database;
    console.log("Database connection ready");

    //steem.config.set('websocket','wss://gtg.steem.house:8090');
    init(function () {
      getLastInfos(function () {
        callback();
      });
    });
  });
}

function init(callback) {
  wait.launchFiber(function() {
    // get steem global properties first, needed for SP calc
    mProperties = wait.for(steem_getSteemGlobalProperties_wrapper);
    console.log("global properties: "+JSON.stringify(mProperties));
    mChainInfo = wait.for(steem_getChainProperties_wrapper);
    console.log("chain info: "+JSON.stringify(mChainInfo));
    // get Steem Power of bot account
    var accounts = wait.for(steem_getAccounts_wrapper, process.env.STEEM_USER);
    mAccount = accounts[0];
    console.log("account: "+JSON.stringify(mAccount));
    // set up some vars
    MIN_SP = Number(process.env.MIN_SP);
    // get test list, if any
    if (process.env.TEST_AUTHOR_LIST !== undefined
      && process.env.TEST_AUTHOR_LIST !== null
      && process.env.TEST_AUTHOR_LIST.localeCompare("null") != 0) {
      mTestAuthorList = process.env.TEST_AUTHOR_LIST.split(",");
      for (var i = 0 ; i < mTestAuthorList.length ; i++) {
        mTestAuthorList[i] = mTestAuthorList[i].toLowerCase().trim();
      }
    }
    callback();
  });
}


function getVoterFromDb(voter, callback) {
  db.collection(DB_VOTERS).find({voter: voter}).toArray(function(err, data) {
    callback(err, data !== null && data.length > 0 ? data[0] : null);
  });
}

function getLastInfos(callback) {
  db.collection(DB_RECORDS).find({}).toArray(function(err, data) {
    if (err || data === null || data === undefined || data.length === 0) {
      console.log("No last infos data in db, is first time run, set up" +
        " with defaults");
      if (process.env.STARTING_BLOCK_NUM !== undefined
        && process.env.STARTING_BLOCK_NUM !== null) {
        mLastInfos = {
          lastBlock: Number(process.env.STARTING_BLOCK_NUM),
          blocked: false
        };
      } else {
        mLastInfos = {
          lastBlock: 0,
          blocked: false
        };
      }
    } else {
      mLastInfos = data[0];
    }
    callback();
  });
}


// --- DB FUNCS

var votersCursor = null;

function getAllVoters_reset(limit) {
  if (votersCursor === null) {
    if (limit !== undefined && limit !== null) {
      votersCursor = db.collection(DB_VOTERS).find({}).limit(limit);
    } else {
      votersCursor = db.collection(DB_VOTERS).find({});
    }
  } else {
    votersCursor = votersCursor.rewind();
  }
}

function getAllVoters(callback) {
  console.log("getAllVoters");
  if (votersCursor === null || votersCursor.isClosed()) {
    console.log("-reset voter db cursor");
    getAllVoters_reset();
  }
  votersCursor.toArray(function(err, data) {
    console.log("db voters collection");
    callback(err, data);
  });
}

function getEachVoter(callback) {
  console.log("getEachVoter");
  if (votersCursor === null || votersCursor.isClosed()) {
    callback(null, []);
  } else {
    votersCursor.each(function(err, data) {
      console.log("db voters collection");
      callback(err, data);
    });
  }
}

var runsCursor = null;

function getAllRuns_reset(limit) {
  if (runsCursor === null) {
    if (limit !== undefined && limit !== null) {
      runsCursor = db.collection(DB_RUNS).find({}).limit(limit);
    } else {
      runsCursor = db.collection(DB_RUNS).find({});
    }
  } else {
    runsCursor = runsCursor.rewind();
  }
}

function getAllRuns(callback) {
  console.log("getAllRuns");
  if (runsCursor === null || runsCursor.isClosed()) {
    console.log("-reset runs db cursor");
    getAllRuns_reset();
  }
  runsCursor.toArray(function(err, data) {
    console.log("db runs collection");
    callback(err, data);
  });
}

var queueCursor = null;

function getAllQueue_reset(limit) {
  if (queueCursor === null) {
    if (limit !== undefined && limit !== null) {
      queueCursor = db.collection(DB_QUEUE).find({}).limit(limit);
    } else {
      queueCursor = db.collection(DB_QUEUE).find({});
    }
  } else {
    queueCursor = queueCursor.rewind();
  }
}

function getAllQueue(callback) {
  console.log("getAllQueue");
  if (queueCursor === null || queueCursor.isClosed()) {
    console.log("-reset queue db cursor");
    getAllQueue_reset();
  }
  queueCursor.toArray(function(err, data) {
    console.log("db queue collection");
    callback(err, data);
  });
}

function mongo_dropQueue_wrapper() {
  db.collection(DB_QUEUE).drop();
}


var flagCursor = null;

function getAllFlag_reset(limit) {
  if (flagCursor === null) {
    if (limit !== undefined && limit !== null) {
      flagCursor = db.collection(DB_FLAGLIST).find({}).limit(limit);
    } else {
      flagCursor = db.collection(DB_FLAGLIST).find({});
    }
  } else {
    flagCursor = flagCursor.rewind();
  }
}

function getAllFlag(callback) {
  console.log("getAllFlag");
  if (flagCursor === null || flagCursor.isClosed()) {
    console.log("-reset flag db cursor");
    getAllFlag_reset();
  }
  flagCursor.toArray(function(err, data) {
    console.log("db flag collection");
    callback(err, data);
  });
}

function mongo_dropFlag_wrapper() {
  db.collection(DB_FLAGLIST).drop();
}


function mongoSave_wrapper(collection, obj, callback) {
  db.collection(collection).save(obj, function (err, data) {
    callback(err, data);
  });
}

function mongoRemove_wrapper(collection, obj, callback) {
  db.collection(collection).remove(obj, function (err, data) {
    callback(err, data);
  });
}

// --- STEEM FUNCS

/*
 getSteemPowerFromVest(vest):
 * converts vesting steem (from get user query) to Steem Power (as on Steemit.com website)
 */
function getSteemPowerFromVest(vest) {
  try {
    return steem.formatter.vestToSteem(
      vest,
      parseFloat(mProperties.total_vesting_shares),
      parseFloat(mProperties.total_vesting_fund_steem)
    );
  } catch(err) {
    return 0;
  }
}

function steem_getBlockHeader_wrapper(blockNum, callback) {
  steem.api.getBlockHeader(blockNum, function(err, result) {
    callback(err, result);
  });
}

function steem_getBlock_wrapper(blockNum, callback) {
  steem.api.getBlock(blockNum, function(err, result) {
    callback(err, result);
  });
}

function steem_getDiscussionsByCreated_wrapper(query, callback) {
  steem.api.getDiscussionsByCreated(query, function (err, result) {
    callback(err, result);
  });
}

function steem_getSteemGlobalProperties_wrapper(callback) {
  steem.api.getDynamicGlobalProperties(function(err, properties) {
    callback(err, properties);
  });
}

function steem_getChainProperties_wrapper(callback) {
  steem.api.getChainProperties(function(err, result) {
    callback(err, result);
  });
}

/**
 *
 * @param type, can be "post" or "comment"
 * @param callback, function with usual (err, data) args
 */
function steem_getRewardFund_wrapper(type, callback) {
  steem.api.getRewardFund(type, function (err, data) {
    callback(err, data);
  });
}

function steem_getCurrentMedianHistoryPrice_wrapper(callback) {
  steem.api.getCurrentMedianHistoryPrice(function(err, result) {
    callback(err, result);
  });
}

function steem_getAccounts_wrapper(author, callback) {
  steem.api.getAccounts([author], function(err, result) {
    callback(err, result);
  });
}

function steem_getAccountCount_wrapper(callback) {
  steem.api.getAccountCount(function(err, result) {
    callback(err, result);
  });
}

function steem_getAccountHistory_wrapper(start, limit, callback) {
  steem.api.getAccountHistory(process.env.STEEM_USER, start, limit, function (err, result) {
    callback(err, result);
  });
}

function steem_getContent_wrapper(author, permlink, callback) {
  steem.api.getContent(author, permlink, function (err, result) {
    callback(err, result);
  });
}

// --- EMAIL FUNCS

/*
 sendEmail(subject, message, isHtml, callback)
 * Send email using SendGrid, if set up
 */
function sendEmail(subject, message, isHtml, callback) {
  console.log("sendEmail with subject: "+subject);
  if (process.env.SENDGRID_API_KEY === undefined
    || process.env.SENDGRID_API_KEY === null
    || process.env.SENDGRID_API_KEY.localeCompare("none") == 0
    || process.env.EMAIL_ADDRESS_LIST === undefined
    || process.env.EMAIL_ADDRESS_LIST === null
    || process.env.EMAIL_ADDRESS_LIST.localeCompare("none") == 0) {
    callback("Can't send email, config vars not set.", null);
  }
  var helper = require('sendgrid').mail;
  var from_email = new helper.Email((process.env.EMAIL_ADDRESS_SENDER
  && process.env.EMAIL_ADDRESS_SENDER.localeCompare("none") != 0)
    ? process.env.EMAIL_ADDRESS_SENDER : 'bot@fossbot.org');
  var content = new helper.Content(isHtml ? 'text/html' : 'text/plain', message);
  // parse email addresses to send to and send
  var emailAddresses = process.env.EMAIL_ADDRESS_LIST.split(",");
  if (emailAddresses === undefined
    || emailAddresses === null
    || emailAddresses.length < 1) {
    callback("Can't send email, could not parse email addresses to", null);
  }
  var sendEmailsNum = 0;
  for (var i = 0 ; i < emailAddresses ; i++) {
    emailAddresses[i] = emailAddresses[i].trim();
    var to_email = new helper.Email(process.env.EMAIL_ADDRESS_TO);
    var mail = new helper.Mail(from_email, subject, to_email, content);
    var sg = require('sendgrid')(process.env.SENDGRID_API_KEY);
    var request = sg.emptyRequest({
      method: 'POST',
      path: '/v3/mail/send',
      body: mail.toJSON()
    });
    try {
      wait.for(sg.API, request);
      console.log("Sent email to "+emailAddresses[i]);
      wait.for(timeout_wrapper, 2000);
      sendEmailsNum++;
    } catch(err) {
      console.log("Error sending email to "+emailAddresses[i]);
    }
  }
  callback(null, "Sent "+sendEmailsNum+" emails");
}

// --- MISC FUNCS

function timeout_wrapper(delay, callback) {
  setTimeout(function() {
    callback(null, true);
  }, delay);
}

// EXPORTS

// consts

module.exports.VOTE_POWER_1_PC = VOTE_POWER_1_PC;

module.exports.DB_RECORDS = DB_RECORDS;
module.exports.DB_VOTERS = DB_VOTERS;
module.exports.DB_RUNS = DB_RUNS;
module.exports.DB_QUEUE = DB_QUEUE;
module.exports.DB_FLAGLIST = DB_FLAGLIST;

module.exports.MIN_SP = MIN_SP;

// getters

module.exports.getAccount = function() {return mAccount};
module.exports.getProperties = function() {return mProperties};
module.exports.getLastInfos = function() {return mLastInfos};
module.exports.getTestAuthorList = function() {return mTestAuthorList};

// setters
module.exports.setLastInfos = function(lastInfos) {mLastInfos = lastInfos;};
module.exports.setAccount = function(account) {mAccount = account;};

// functions

module.exports.mongoSave_wrapper = mongoSave_wrapper;
module.exports.mongoRemove_wrapper = mongoRemove_wrapper;
module.exports.getVoterFromDb = getVoterFromDb;
module.exports.getAllRuns_reset = getAllRuns_reset;
module.exports.getAllRuns = getAllRuns;
module.exports.getAllVoters_reset = getAllVoters_reset;
module.exports.getAllVoters = getAllVoters;
module.exports.getEachVoter = getEachVoter;
module.exports.getAllQueue_reset = getAllQueue_reset;
module.exports.getAllQueue = getAllQueue;
module.exports.mongo_dropQueue_wrapper = mongo_dropQueue_wrapper;
module.exports.getAllFlag_reset = getAllFlag_reset;
module.exports.getAllFlag = getAllFlag;
module.exports.mongo_dropFlag_wrapper = mongo_dropFlag_wrapper;

module.exports.getSteemPowerFromVest = getSteemPowerFromVest;
module.exports.steem_getBlockHeader_wrapper = steem_getBlockHeader_wrapper;
module.exports.steem_getBlock_wrapper = steem_getBlock_wrapper;
module.exports.steem_getDiscussionsByCreated_wrapper = steem_getDiscussionsByCreated_wrapper;
module.exports.steem_getSteemGlobalProperties_wrapper = steem_getSteemGlobalProperties_wrapper;
module.exports.steem_getCurrentMedianHistoryPrice_wrapper = steem_getCurrentMedianHistoryPrice_wrapper;
module.exports.steem_getChainProperties_wrapper = steem_getChainProperties_wrapper;
module.exports.steem_getRewardFund_wrapper = steem_getRewardFund_wrapper;
module.exports.steem_getAccounts_wrapper = steem_getAccounts_wrapper;
module.exports.steem_getAccountCount_wrapper = steem_getAccountCount_wrapper;
module.exports.steem_getAccountHistory_wrapper = steem_getAccountHistory_wrapper;
module.exports.steem_getContent_wrapper = steem_getContent_wrapper;

module.exports.start = start;
module.exports.sendEmail = sendEmail;
module.exports.timeout_wrapper = timeout_wrapper;