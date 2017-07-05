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
  DB_RUNS = "runs";

const
  VOTE_POWER_1_PC = 100,
  DATE_FORMAT = "dddd, MMMM Do YYYY, h:mm:ss a";

var
  MIN_SP;

var ObjectID = mongodb.ObjectID;
var db;

var mAccount = null;
var mProperties = null;
var mTestAuthorList = null;


// Connect to the database first
mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
  if (err) {
    console.log(err);
    process.exit(1);
  }

  db = database;
  console.log("Database connection ready");

  main();
});

function main() {
  steem.config.set('websocket','wss://gtg.steem.house:8090');
  init(function () {
    doReport(function (err, html) {
      sendEmail("smackdown.kitty report", html, true, function (err, data) {
        if (err) {
          console.log("Could not send email: "+err);
        } else {
          console.log("Finished successfully");
        }
      });
    });
  });
}

function init(callback) {
  wait.launchFiber(function() {
    // get steem global properties first, needed for SP calc
    mProperties = wait.for(steem_getSteemGlobalProperties_wrapper);
    console.log("global properties: "+JSON.stringify(mProperties));
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

function doReport(callback) {
  var html = "<html><head>Self Voting Flagger - Report</head><body>";
  // basic stuff
  html += "<h3>on account @"+process.env.STEEM_USER+"</h3>";
  var runs = wait.for(getAllRuns);
  var voters = wait.for(getAllVoters);
  html += "<p>Number of runs: "+runs.length+"</p>";
  html += "<p>Number of unique comment self voters: "+voters.length+"</p>";
  // Do per day stats
  html += "<h1>Summary stats</h1>";
  html += "<table>";
  html += "<tr>";
  html += "<td>Start time (block)</td>";
  html += "<td>End time (block)</td>";
  html += "<td>Total votes</td>";
  html += "<td>Total self votes</td>";
  html += "<td>Total self voted comments</td>";
  html += "<td>Total self voted comments > 1000 SP</td>";
  html += "</tr>";
  var lastDayOfYear = -1;
  var dayCounter = 0;
  var summary = null;
  var summaries = [];
  for (var i = 0 ; i < runs.length ; i++) {
    var run = runs[i];
    var startBlockInfo = wait.for(steem_getBlockHeader_wrapper, run.start_block);
    var endBlockInfo = wait.for(steem_getBlockHeader_wrapper, run.end_block);
    var startMoment = moment(startBlockInfo.timestamp, moment.ISO_8601);
    var endMoment = moment(endBlockInfo.timestamp, moment.ISO_8601);
    if (lastDayOfYear < startMoment.dayOfYear()
        || startMoment.dayOfYear() < endMoment.dayOfYear()) {
      // first process what we have, if anything
      if (summary !== null) {
        var summaryStartMoment = moment(summary.start_time, moment.ISO_8601);
        var summaryEndMoment = moment(summary.end_time, moment.ISO_8601);
        html += "<tr>";
        html += "<td>"+summaryStartMoment.format(DATE_FORMAT)+" ("+summary.start_time+")</td>";
        html += "<td>"+summaryEndMoment.format(DATE_FORMAT)+" ("+summary.end_time+")</td>";
        html += "<td>"+summary.votes_total+"</td>";
        html += "<td>"+summary.selfvotes_total+"</td>";
        html += "<td>"+summary.selfvotes_comments+"</td>";
        html += "<td>"+summary.selfvotes_high_sp_comments+"</td>";
        html += "</tr>";
        summaries.push(summary);
      }
      // RESET DAY SUMMARY FOR NEW DAY
      dayCounter++;
      // note, we expect this first time also
      summary = {
        start_time: startBlockInfo.timestamp,
        end_time: endBlockInfo.timestamp,
        start_block: run.start_block,
        end_block: 0,
        votes_total: run.votes_total,
        selfvotes_total: run.selfvotes_total,
        selfvotes_comments: run.selfvotes_comments,
        selfvotes_high_sp_comments: run.selfvotes_high_sp_comments
      };
    } else {
      summary.end_time = endBlockInfo.timestamp; //always update so is last
      summary.votes_total += run.votes_total;
      summary.selfvotes_total += run.selfvotes_total;
      summary.selfvotes_comments += run.selfvotes_comments;
      summary.selfvotes_high_sp_comments += run.selfvotes_high_sp_comments;
    }
  }
  html += "</table>";
  html += "</body></html>";
  callback(null, html);
}



function getAllVoters(callback) {
  db.collection(DB_VOTERS).find({}).toArray(function(err, data) {
    callback(err, data);
  });
}

function getAllRuns(callback) {
  db.collection(DB_RUNS).find({}).toArray(function(err, data) {
    callback(err, data);
  });
}

function steem_getSteemGlobalProperties_wrapper(callback) {
  steem.api.getDynamicGlobalProperties(function(err, properties) {
    callback(err, properties);
  });
}

function steem_getAccounts_wrapper(author, callback) {
  steem.api.getAccounts([author], function(err, result) {
    callback(err, result);
  });
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

function timeout_wrapper(delay, callback) {
  setTimeout(function() {
    callback(null, true);
  }, delay);
}

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