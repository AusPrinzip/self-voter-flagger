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
  VOTE_POWER_1_PC = 100;

var
  MIN_SP;

var ObjectID = mongodb.ObjectID;
var db;

var mAccount = null;
var mProperties = null;
var mLastInfos = null;
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
  //steem.config.set('websocket','wss://steemd.steemit.com');
  init(function () {
    getLastInfos(function () {
      doProcess(mLastInfos.lastBlock, function () {
        console.log("Finished");
      });
    });
  });
}

function init(callback) {
  wait.launchFiber(function() {
    // get steem global properties first, needed for SP calc
    mProperties = wait.for(steem_getSteemGlobaleProperties_wrapper);
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


function doProcess(startAtBlockNum, callback) {
  wait.launchFiber(function() {
    var totalVotes = 0;
    var numSelfVotes = 0;
    var numSelfComments = 0;
    var numSelfVotesToProcess = 0;
    for (var i = startAtBlockNum; i <= mProperties.head_block_number; i++) {
      var block = wait.for(steem_getBlock_wrapper, i);
      // create current time moment from block infos
      var latestBlockMoment = moment(block. timestamp, moment.ISO_8601);
      //console.log("block info: "+JSON.stringify(block));
      var transactions = block.transactions;
      for (var j = 0; j < transactions.length; j++) {
        var transaction = transactions[j];
        for (var k = 0 ; k < transaction.operations.length ; k++) {
          var opName = transaction.operations[k][0];
          var opDetail = transaction.operations[k][1];
          //try {
            if (opName !== undefined && opName !== null
              && opName.localeCompare("vote") == 0) {

              totalVotes++;

              // check vote is a self vote
              if (opDetail.voter.localeCompare(opDetail.author) != 0) {
                continue;
              }
              numSelfVotes++;

              console.log("- self vote at b " + i + ":t " + j + ":op " +
                k + ", detail:" + JSON.stringify(opDetail));

              // FIRST, screen for comments only
              var permlinkParts = opDetail.permlink.split("-");
              if (permlinkParts.length === 0
                || !moment(permlinkParts[permlinkParts.length - 1], "YYYYMMDDtHHmmssSSSz").isValid()) {
                console.log("Not a comment, skipping")
                continue;
              }

              // THIRD, get rshares of vote from post
              var content;
              // TODO : cache posts
              content = wait.for(steem_getContent_wrapper, opDetail.author,
                opDetail.permlink);
              if (content === undefined || content === null) {
                console.log("Couldn't process operation, continuing." +
                  " Error: post content response not defined");
                continue;
              }
              var voteDetail = null;
              for (var m = 0; m < content.active_votes.length; m++) {
                if (content.active_votes[m].voter.localeCompare(opDetail.voter) == 0) {
                  voteDetail = content.active_votes[m];
                  break;
                }
              }
              if (voteDetail === null) {
                console.log("vote details null, cannot process, skip");
                continue;
              }

              // FOURTH, check if vote rshares are > 0, cancelled self votes
              // have rshares == 0
              if (voteDetail.rshares === 0) {
                console.log("self vote negated, well done! skipping");
                continue;
              }
              if (voteDetail.rshares < 0) {
                console.log("self flag?! skipping");
                continue;
              }

              // is a self voted comment
              numSelfComments++;

              // SECOND, check their SP
              // TODO : cache user accounts
              var accounts = wait.for(steem_getAccounts_wrapper, opDetail.voter);
              var voterAccount = accounts[0];
              // TODO : take delegated stake into consideration?
              var steemPower = getSteemPowerFromVest(voterAccount.vesting_shares);
              if (steemPower < MIN_SP) {
                console.log("SP of "+opDetail.voter+" < min of "+MIN_SP
                  +", skipping");
                continue;
              }

              // has enough SP to be of interest
              numSelfVotesToProcess++;

              // update db with this voter info
              var voterInfos = wait.for(getVoterFromDb, opDetail.voter);
              if (voterInfos === null || voterInfos === undefined) {
                voterInfos = {
                  voter: opDetail.voter,
                  selfvotes: 1,
                  selfvotes_permlinks: [content.permlink]
                };
              } else {
                voterInfos.selfvotes = voterInfos.selfvotes + 1;
                voterInfos.selfvotes_permlinks.push(content.permlink);
              }
              wait.for(mongoSave_wrapper, DB_VOTERS, voterInfos);
              console.log("* voter updated: "+JSON.stringify(voterInfos));

              console.log("--DEBUG CALC VOTE PERCENTAGE--");
              var abs_need_rshares = Math.abs(voteDetail.rshares);
              console.log(" - abs_need_rshares: "+abs_need_rshares);
              var vp = recalcVotingPower(latestBlockMoment);
              console.log(" - vp: "+vp);
              // note, these constants are not fully understood
              // the _50_ constant was 200, and could possibly be better at 40
              // TODO : confirm constants are correct
              // TODO : take delegated stake into consideration?
              console.log(" - abs_percentage calc");
              console.log(" - - mAccount.vesting_shares: "+mAccount.vesting_shares);
              console.log(" - - mAccount.received_vesting_shares" +
                " (delegated from others): "+mAccount.received_vesting_shares);
              var vestingSharesParts = mAccount.vesting_shares.split(" ");
              var vestingSharesNum = Number(vestingSharesParts[0]);
              console.log(" - - vesting_shares num: "+vestingSharesNum);
              var receivedSharesParts = mAccount.received_vesting_shares.split(" ");
              var receivedSharesNum = Number(receivedSharesParts[0]);
              console.log(" - - received_vesting_shares num: "+receivedSharesNum);
              var abs_percentage = (abs_need_rshares * 10000 * 100 * 50 / vp / (vestingSharesNum + receivedSharesNum));
              console.log(" - abs_percentage: "+abs_percentage);
              if (abs_percentage > 100) {
                abs_percentage = 100;
              }
              console.log(" - abs_percentage(corrected) : "+abs_percentage);

              var abs_counter_percentage = voterInfos.selfvotes;
              console.log(" - abs_counter_percentage: "+abs_counter_percentage);
              if (abs_counter_percentage > 100) {
                abs_counter_percentage = 100;
                console.log(" - abs_counter_percentage(fixed): "+abs_counter_percentage);
              }
              if (abs_counter_percentage > abs_percentage) {
                console.log(" - abs_counter_percentage(bounded): "+abs_counter_percentage);
              }
              var counter_percentage = -abs_counter_percentage;
              console.log("countering percentage: "+counter_percentage);
              console.log("Voting...");
              var restricted = false;
              if (mTestAuthorList !== null
                  && mTestAuthorList !== undefined
                  && mTestAuthorList.length > 0) {
                restricted = true;
                for (var m = 0 ; m < mTestAuthorList.length ; m++) {
                  if (opDetail.voter.localeCompare(mTestAuthorList[m]) === 0) {
                    restricted = false;
                    break;
                  }
                }
              }
              if (!restricted) {
                if (process.env.ACTIVE !== undefined
                  && process.env.ACTIVE !== null
                  && process.env.ACTIVE.localeCompare("true") == 0) {
                  try {
                    var voteResult = wait.for(steem.broadcast.vote,
                      process.env.POSTING_KEY_PRV,
                      process.env.STEEM_USER,
                      content.author,
                      content.permlink,
                      (counter_percentage * VOTE_POWER_1_PC)); // adjust pc to Steem scaling
                    console.log("Vote result: "+JSON.stringify(voteResult));
                    console.log("Wait 3.5 seconds to allow vote limit to" +
                      " reset");
                    var timeoutResult = wait.for(timeout_wrapper, 3500);
                    console.log("Finished waiting");
                  } catch(err) {
                    console.log("Error voting: "+JSON.stringify(err));
                  }
                } else {
                  console.log("Bot not in active state, not voting");
                }
              } else {
                console.log("Not voting, author restriction list not" +
                  " met");
              }
            }
            /*
          } catch (err) {
            console.log("Couldn't process operation, continuing. Error: "
              + JSON.stringify(err));
            continue;
          }
          */
        }
      }
    }
    console.log("NUM SELF VOTES from block "+startAtBlockNum+" to " +
      mProperties.head_block_number + " is "+numSelfVotes +
      ", of which "+numSelfComments+"("+numSelfVotesToProcess+" processed)"+
      " are comments out of " + totalVotes + " total votes");
    wait.for(mongoSave_wrapper, DB_RUNS,
      {
        start_block: startAtBlockNum,
        end_block: mProperties.head_block_number,
        votes_total: totalVotes,
        selfvotes_total: numSelfVotes,
        selfvotes_comments: numSelfComments,
        selfvotes_high_sp_comments: numSelfVotesToProcess
      });
    mLastInfos.lastBlock = mProperties.head_block_number;
    wait.for(mongoSave_wrapper, DB_RECORDS, mLastInfos);
    callback();
  });
}

function timeout_wrapper(delay, callback) {
  setTimeout(function() {
    callback(null, true);
  }, delay);
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
          lastBlock: Number(process.env.STARTING_BLOCK_NUM)
        };
      } else {
        mLastInfos = {
          lastBlock: 0
        };
      }
    } else {
      mLastInfos = data[0];
    }
    callback();
  });
}

function recalcVotingPower(latestBlockMoment) {
  // update account
  var accounts = wait.for(steem_getAccounts_wrapper, process.env.STEEM_USER);
  mAccount = accounts[0];
  if (mAccount === null || mAccount === undefined) {
    console.log("Could not get bot account detail")
  }
  var vp = mAccount.voting_power;
  console.log(" - - bot vp: "+vp);
  //last_vote_time = Time.parse(r["last_vote_time"] + 'Z')
  var lastVoteTime = moment(mAccount.last_vote_time);
  console.log(" - - lastVoteTime: "+lastVoteTime);
  //now_time = Time.parse(@latest_block["timestamp"] + 'Z')
  console.log(" - - latestBlockMoment(supplied): "+latestBlockMoment);
  var secondsDiff = latestBlockMoment.seconds() - lastVoteTime.seconds();
  console.log(" - - secondsDiff: "+secondsDiff);
  if (secondsDiff > 0) {
    var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
    console.log(" - - vpRegenerated: "+vpRegenerated);
    vp += vpRegenerated;
    console.log(" - - new vp: "+vp);
  } else {
    console.log(" - - - negative seconds diff, do not use");
  }
  if (vp > 10000) {
    vp = 10000;
  }
  console.log(" - - new vp(corrected): "+vp);
  return vp;
}

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

function steem_getSteemGlobaleProperties_wrapper(callback) {
  steem.api.getDynamicGlobalProperties(function(err, properties) {
    callback(err, properties);
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


function mongoSave_wrapper(collection, obj, callback) {
  db.collection(collection).save(obj, function (err, data) {
    callback(err, data);
  });
}