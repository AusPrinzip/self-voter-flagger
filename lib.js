'use strict';

const steem = require('steem');
// const path = require('path');
const mongodb = require('mongodb');
// const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');

const DB_RECORDS = 'records';
const DB_VOTERS = 'voters';
const DB_RUNS = 'runs';
const DB_QUEUE = 'queue';
const DB_FLAGLIST = 'flaglist';

const VOTE_POWER_1_PC = 100;
// const DATE_FORMAT = 'dddd, MMMM Do YYYY, h:mm:ss a';

var MIN_SP = 1000;

var db;

var mAccount = null;
var mProperties = null;
var mChainInfo = null;
var mLastInfos = null;
var mTestAuthorList = null;

// Connect to the database first

function start (callback) {
  mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
    if (err) {
      console.log(err);
      process.exit(1);
    }

    db = database;
    console.log('Database connection ready');

    // steem.config.set('websocket','wss://gtg.steem.house:8090');
    init(function () {
      fetchLastInfos(function () {
        callback();
      });
    });
  });
}

function init (callback) {
  wait.launchFiber(function () {
    // get steem global properties first, needed for SP calc
    mProperties = wait.for(getGlobalProperties);
    console.log('global properties: ' + JSON.stringify(mProperties));
    mChainInfo = wait.for(getChainProperties);
    console.log('chain info: ' + JSON.stringify(mChainInfo));
    // get Steem Power of bot account
    var accounts = wait.for(getSteemAccounts, process.env.STEEM_USER);
    mAccount = accounts[0];
    console.log('account: ' + JSON.stringify(mAccount));
    // set up some vars
    MIN_SP = Number(process.env.MIN_SP);
    // get test list, if any
    if (process.env.TEST_AUTHOR_LIST !== undefined &&
        process.env.TEST_AUTHOR_LIST !== null &&
        process.env.TEST_AUTHOR_LIST.localeCompare('null') !== 0) {
      mTestAuthorList = process.env.TEST_AUTHOR_LIST.split(',');
      for (var i = 0; i < mTestAuthorList.length; i++) {
        mTestAuthorList[i] = mTestAuthorList[i].toLowerCase().trim();
      }
    }
    callback();
  });
}

function fetchLastInfos (callback) {
  db.collection(DB_RECORDS).find({}).toArray(function (err, data) {
    if (err || data === null || data === undefined || data.length === 0) {
      console.log('No last infos data in db, is first time run, set up with defaults');
      if (process.env.STARTING_BLOCK_NUM !== undefined &&
          process.env.STARTING_BLOCK_NUM !== null) {
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

function getDbCursor (dbName, limit) {
  var cursor = null;
  if (limit !== undefined && limit !== null) {
    cursor = db.collection(dbName).find({}).limit(limit);
  } else {
    cursor = db.collection(dbName).find({});
  }
  return cursor;
}

function getAllRecordsFromDb (dbName, callback) {
  db.collection(dbName).find({}).toArray(function (err, data) {
    callback(err, data);
  });
}

function getRecordsFromDb (dbName, recordSearchObj, callback) {
  db.collection(dbName).find(recordSearchObj).toArray(function (err, data) {
    if (callback !== undefined && callback !== null) {
      if (err) {
        callback(err, null);
      } else if (data === null || data === undefined || data.length === 0) {
        callback(null, null);
      } else {
        callback(null, data);
      }
    }
  });
}

function getRecordFromDb (dbName, recordSearchObj, callback) {
  getRecordsFromDb(dbName, recordSearchObj, function (err, data) {
    if (err) {
      callback(err, null);
    } else if (data === null || data === undefined || data.length === 0) {
      callback(null, null);
    } else {
      callback(null, data[0]);
    }
  });
}

function addAllToDb (dbName, records, callback) {
  db.collection(dbName).insertMany(records, function (err, data) {
    if (callback !== undefined && callback !== null) {
      callback(err, data);
    }
  });
}

function dropDb (dbName, callback) {
  getDbCursor(dbName).count(function (err, count) {
    if (err) {
      console.error(err);
    } else if (count > 0) {
      db.collection(dbName).drop();
    } else {
      console.log('Cant drop db ' + dbName + ', no records');
    }
    callback(err, null);
  });
}

function saveDb (dbName, obj, callback) {
  db.collection(dbName).save(obj, function (err, data) {
    if (callback !== undefined && callback !== null) {
      callback(err, data);
    }
  });
}

// --- STEEM FUNCS

/*
 getSteemPowerFromVest(vest):
 * converts vesting steem (from get user query) to Steem Power (as on Steemit.com website)
 */
function getSteemPowerFromVest (vest) {
  try {
    return steem.formatter.vestToSteem(
      vest,
      parseFloat(mProperties.total_vesting_shares),
      parseFloat(mProperties.total_vesting_fund_steem)
    );
  } catch (err) {
    return 0;
  }
}

function getBlockHeader (blockNum, callback) {
  steem.api.getBlockHeader(blockNum, function (err, result) {
    callback(err, result);
  });
}

function getBlock (blockNum, callback) {
  steem.api.getBlock(blockNum, function (err, result) {
    callback(err, result);
  });
}

function getPostsByCreated (query, callback) {
  steem.api.getDiscussionsByCreated(query, function (err, result) {
    callback(err, result);
  });
}

function getGlobalProperties (callback) {
  steem.api.getDynamicGlobalProperties(function (err, properties) {
    callback(err, properties);
  });
}

function getChainProperties (callback) {
  steem.api.getChainProperties(function (err, result) {
    callback(err, result);
  });
}

/**
 *
 * @param type, can be "post" or "comment"
 * @param callback, function with usual (err, data) args
 */
function getRewardFund (type, callback) {
  steem.api.getRewardFund(type, function (err, data) {
    callback(err, data);
  });
}

function getCurrentMedianHistoryPrice (callback) {
  steem.api.getCurrentMedianHistoryPrice(function (err, result) {
    callback(err, result);
  });
}

function getSteemAccounts (author, callback) {
  steem.api.getAccounts([author], function (err, result) {
    callback(err, result);
  });
}

function getSteemAccountCount (callback) {
  steem.api.getAccountCount(function (err, result) {
    callback(err, result);
  });
}

function getSteemAccountHistory (start, limit, callback) {
  steem.api.getAccountHistory(process.env.STEEM_USER, start, limit, function (err, result) {
    callback(err, result);
  });
}

function getPostContent (author, permlink, callback) {
  steem.api.getContent(author, permlink, function (err, result) {
    callback(err, result);
  });
}

// --- EMAIL FUNCS

/*
 sendEmail(subject, message, isHtml, callback)
 * Send email using SendGrid, if set up
 */
function sendEmail (subject, message, isHtml, callback) {
  console.log('sendEmail with subject: ' + subject);
  if (process.env.SENDGRID_API_KEY === undefined ||
      process.env.SENDGRID_API_KEY === null ||
      process.env.SENDGRID_API_KEY.localeCompare('none') === 0 ||
      process.env.EMAIL_ADDRESS_LIST === undefined ||
      process.env.EMAIL_ADDRESS_LIST === null ||
      process.env.EMAIL_ADDRESS_LIST.localeCompare('none') === 0) {
    callback(new Error('Cant send email, config vars not set.'), null);
  }
  var helper = require('sendgrid').mail;
  var fromEmail = new helper.Email((process.env.EMAIL_ADDRESS_SENDER &&
      process.env.EMAIL_ADDRESS_SENDER.localeCompare('none') !== 0)
      ? process.env.EMAIL_ADDRESS_SENDER : 'bot@bot.org');
  var content = new helper.Content(isHtml ? 'text/html' : 'text/plain', message);
  // parse email addresses to send to and send
  var emailAddresses = process.env.EMAIL_ADDRESS_LIST.split(',');
  if (emailAddresses === undefined ||
      emailAddresses === null ||
      emailAddresses.length < 1) {
    callback(new Error('Cant send email, could not parse email addresses to'), null);
  }
  var sendEmailsNum = 0;
  for (var i = 0; i < emailAddresses; i++) {
    emailAddresses[i] = emailAddresses[i].trim();
    var toEmail = new helper.Email(process.env.EMAIL_ADDRESS_TO);
    var mail = new helper.Mail(fromEmail, subject, toEmail, content);
    var sg = require('sendgrid')(process.env.SENDGRID_API_KEY);
    var request = sg.emptyRequest({
      method: 'POST',
      path: '/v3/mail/send',
      body: mail.toJSON()
    });
    try {
      wait.for(sg.API, request);
      console.log('Sent email to ' + emailAddresses[i]);
      wait.for(timeoutWait, 2000);
      sendEmailsNum++;
    } catch (err) {
      console.log('Error sending email to ' + emailAddresses[i]);
    }
  }
  callback(null, 'Sent ' + sendEmailsNum + ' emails');
}

// --- MISC FUNCS

function timeoutWait (delay, callback) {
  setTimeout(function () {
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

module.exports.getAccount = function () { return mAccount; };
module.exports.getProperties = function () { return mProperties; };
module.exports.getLastInfos = function () { return mLastInfos; };
module.exports.getTestAuthorList = function () { return mTestAuthorList; };

// setters
module.exports.setLastInfos = function (lastInfos) { mLastInfos = lastInfos; };
module.exports.setAccount = function (account) { mAccount = account; };

// functions

module.exports.getDbCursor = getDbCursor;
module.exports.getAllRecordsFromDb = getAllRecordsFromDb;
module.exports.getRecordsFromDb = getRecordsFromDb;
module.exports.getRecordFromDb = getRecordFromDb;
module.exports.addAllToDb = addAllToDb;
module.exports.dropDb = dropDb;
module.exports.saveDb = saveDb;

module.exports.getSteemPowerFromVest = getSteemPowerFromVest;
module.exports.getBlockHeader = getBlockHeader;
module.exports.getBlock = getBlock;
module.exports.getPostsByCreated = getPostsByCreated;
module.exports.getGlobalProperties = getGlobalProperties;
module.exports.getCurrentMedianHistoryPrice = getCurrentMedianHistoryPrice;
module.exports.getChainProperties = getChainProperties;
module.exports.getRewardFund = getRewardFund;
module.exports.getSteemAccounts = getSteemAccounts;
module.exports.getSteemAccountCount = getSteemAccountCount;
module.exports.getSteemAccountHistory = getSteemAccountHistory;
module.exports.getPostContent = getPostContent;

module.exports.start = start;
module.exports.sendEmail = sendEmail;
module.exports.timeoutWait = timeoutWait;
