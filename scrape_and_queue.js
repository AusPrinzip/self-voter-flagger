'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for'),
  lib = require('./lib.js');

var
  MAX_BLOCKS_PER_RUN = 1000,//MAX_BLOCKS_PER_RUN = 12340,
  MAX_USAGE_NUM_TO_CHECK = 20,
  MAX_POSTS_TO_CONSIDER = 20; //default


function main() {
  lib.start(function () {
    doProcess(lib.getLastInfos().lastBlock + 1, function () {
      console.log("Finished");
    });
  });
}

const MAX_ACCOUNTS_MAP_SIZE = 1000;
var sAccountsMap = {};

function getAccount(name) {
  var account = sAccountsMap[name];
  if (account !== null && account !== undefined) {
    //console.log(" * got account from CACHE: "+name);
    sAccountsMap[name][0] = sAccountsMap[name][0] + 1;
    return account[1];
  }
  var store = true;
  if (Object.keys(sAccountsMap).length >= MAX_ACCOUNTS_MAP_SIZE) {
    var deletedOne = false;
    // find least used account
    var smallestNumber = 1;
    while (smallestNumber < MAX_USAGE_NUM_TO_CHECK) {
      for (var key in sAccountsMap) {
        if (sAccountsMap[key][0] === smallestNumber) {
          // remove this
          //console.log(" * removed a account from cache: "+key);
          delete sAccountsMap[key];
          deletedOne = true;
          break;
        }
      }
      smallestNumber++;
      if (deletedOne) {
        break;
      }
    }
    if (!deletedOne) {
      store = false;
    }
  }
  try {
    account = wait.for(lib.steem_getAccounts_wrapper, name)[0];
  } catch(err) {
    console.log("Couldn't get account for "+name+": "+JSON.stringify(err));
    return null;
  }
  if (store) {
    //console.log(" * got account from API: "+name+" (stored)");
    sAccountsMap[name] = [1, account];
  }// else {
   // console.log(" * got account from API: "+name+" (NOT stored)");
  //}
  return account;
}

const MAX_POSTS_MAP_SIZE = 100;
var sPostsMap = {};

function getPost(author, permlink, forceUpdate) {
  var thisKey = author+":"+permlink;
  var post = sPostsMap[thisKey];
  var store = true;
  if (!forceUpdate) {
    if (post !== null && post !== undefined) {
      //console.log(" * got post from CACHE: "+thisKey);
      sPostsMap[thisKey][0] = sPostsMap[thisKey][0] + 1;
      return post[1];
    }
    if (Object.keys(sPostsMap).length >= MAX_POSTS_MAP_SIZE) {
      var deletedOne = false;
      // find least used account
      var smallestNumber = 1;
      while (smallestNumber < MAX_USAGE_NUM_TO_CHECK) {
        for (var key in sPostsMap) {
          if (sPostsMap[key][0] === smallestNumber) {
            // remove this
            //console.log(" * removed a post from cache: "+key);
            delete sPostsMap[key];
            deletedOne = true;
            break;
          }
        }
        smallestNumber++;
        if (deletedOne) {
          break;
        }
      }
      if (!deletedOne) {
        store = false;
      }
    }
  }
  try {
    post = wait.for(lib.steem_getContent_wrapper, author, permlink);
  } catch(err) {
    console.log("Couldn't get post for "+thisKey);
    return null;
  }
  if (store) {
    //console.log(" * got post from API: "+thisKey+" (stored)");
    sPostsMap[thisKey] = [1, post];
  }// else {
   // console.log(" * got post from API: "+thisKey+" (NOT stored)");
  //}
  return post;
}


var queue = [];

function doProcess(startAtBlockNum, callback) {
  wait.launchFiber(function() {
    // get queue
    queue = wait.for(lib.getAllQueue);
    if (queue === undefined
        || queue === null) {
      queue = [];
    }
    // set up vars
    var firstBlockMoment = null;
    var currentBlockNum = 0;
    for (var i = startAtBlockNum; i <= lib.getProperties().head_block_number && i <= (startAtBlockNum + MAX_BLOCKS_PER_RUN); i++) {
      currentBlockNum = i;
      var block = wait.for(lib.steem_getBlock_wrapper, i);
      // create current time moment from block infos
      var latestBlockMoment = moment(block. timestamp, moment.ISO_8601);
      if (firstBlockMoment === null) {
        firstBlockMoment = latestBlockMoment;
      } else {
        if (firstBlockMoment.dayOfYear() < latestBlockMoment.dayOfYear()) {
          // exit, the have processed entire day
          currentBlockNum--;
          break;
        }
      }
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

              // THEN, check their SP is above minimum
              // get account from cache if possible, otherwise cache it
              var voterAccount = getAccount(opDetail.voter);
              if (voterAccount === null) {
                continue;
              }
              // take delegated stake into consideration?
              var steemPower = lib.getSteemPowerFromVest(
                  voterAccount.vesting_shares
                  + voterAccount.received_vesting_shares
                  - voterAccount.delegated_vesting_shares);
              if (steemPower < lib.MIN_SP) {
                console.log("SP of "+opDetail.voter+" < min of "+lib.MIN_SP
                  +", skipping");
                continue;
              }

              // get post content and rshares of vote
              var content = getPost(opDetail.author, opDetail.permlink, false);
              if (content === undefined || content === null) {
                console.log("Couldn't process operation, continuing." +
                  " Error: post content response not defined");
                continue;
              }
              if (content.active_votes === undefined
                || content.active_votes === null) {
                content = getPost(opDetail.author, opDetail.permlink, true);
                if (content === undefined || content === null) {
                  console.log("Couldn't process operation, continuing." +
                    " Error: post content response not defined");
                  continue;
                }
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

              // basic deciding info
              var isComment = false;
              var isFlag = false;
              var isVoteNegation = false;
              var isSelfVote = false;

              // THEN, check if vote rshares are > 0
              // note: cancelled self votes have rshares == 0
              if (voteDetail.rshares < 0) {
                //console.log(" - - - flag");
                isFlag = true;
              } else if (voteDetail.rshares > 0) {
                //console.log(" - - - up vote");
              } else {
                //console.log(" - - - vote NEGATED");
                isVoteNegation = true;
              }

              // FIRST, screen for comments only
              isComment = true;
              var permlinkParts = opDetail.permlink.split("-");
              if (permlinkParts.length === 0
                || !S(permlinkParts[permlinkParts.length - 1]).startsWith("201")
                || !S(permlinkParts[permlinkParts.length - 1]).endsWith("z")
                || permlinkParts[permlinkParts.length - 1].indexOf("t") < 0) {
                //console.log("Not a comment, skipping");
                //continue;
                isComment = false;
              }

              // THEN, check vote is a self vote
              if (opDetail.voter.localeCompare(opDetail.author) === 0) {
                isSelfVote = true;
              }

              // update voter db
              var voterInfos = wait.for(lib.getVoterFromDb, opDetail.voter);
              if (voterInfos === undefined || voterInfos === null) {
                voterInfos = {
                  voter: opDetail.voter,
                  post_flag: 0,
                  post_selfvote: 0,
                  post_outvote: 0,
                  comment_flag: 0,
                  comment_selfvote: 0,
                  comment_outvote: 0,
                  total_self_vote_payout: 0.0,
                  steempower_self: 0,
                  steempower_net: 0
                };
              }
              // add to relevant vote counter
              if (!isComment) {
                if (isFlag) {
                  voterInfos.post_flag = voterInfos.post_flag + 1;
                } else if (isSelfVote) {
                  voterInfos.post_selfvote = voterInfos.post_selfvote + 1;
                } else {
                  voterInfos.post_outvote = voterInfos.post_outvote + 1;
                }
              } else {
                if (isFlag) {
                  voterInfos.comment_flag = voterInfos.comment_flag + 1;
                } else if (isSelfVote) {
                  voterInfos.comment_selfvote = voterInfos.comment_selfvote + 1;
                } else {
                  voterInfos.comment_outvote = voterInfos.comment_outvote + 1;
                }
              }
              // update data
              voterInfos.steempower_self = lib.getSteemPowerFromVest(voterAccount.vesting_shares);
              voterInfos.steempower_net = voterInfos.steempower_self
                + lib.getSteemPowerFromVest(voterAccount.received_vesting_shares)
                - lib.getSteemPowerFromVest(voterAccount.delegated_vesting_shares);

              if (!isSelfVote || !isComment || isFlag || isVoteNegation) {
                // TODO : do something about the vote negation
                // save voter data here
                wait.for(lib.mongoSave_wrapper, lib.DB_VOTERS, voterInfos);
                continue;
              }

              // THEN, check payout window still open
              var recordOnly = false;
              var cashoutTime = moment(content.cashout_time);
              cashoutTime.subtract(7, 'hours');
              var nowTime = moment(new Date());
              if (!nowTime.isBefore(cashoutTime)) {
                console.log("payout window now closed, only keep record," +
                  " do not consider for flag");
                recordOnly = true;
              }

              // consider for flag queue
              console.log("content.pending_payout_value: "+content.pending_payout_value);
              var pending_payout_value = content.pending_payout_value.split(" ");
              var pending_payout_value_NUM = Number(pending_payout_value[0]);
              console.log("content.net_rshares: "+content.net_rshares);
              var self_vote_payout;
              if (pending_payout_value_NUM <= 0.00) {
                self_vote_payout = 0;
              } else if (content.active_votes.length === 1
                  || voteDetail.rshares === Number(content.vote_rshares)) {
                self_vote_payout = pending_payout_value_NUM;
              } else {
                self_vote_payout = pending_payout_value_NUM * (voteDetail.rshares / Number(content.vote_rshares));
              }
              console.log("self_vote_payout: "+self_vote_payout);
              // ignore negative or zero payout values
              if (self_vote_payout > 0) {

                // update voter info with payout
                voterInfos.total_self_vote_payout = voterInfos.total_self_vote_payout + self_vote_payout;

                // add to queue if high enough self vote payout
                var selfVoteObj = {
                  permlink: content.permlink,
                  rshares: voteDetail.rshares,
                  self_vote_payout: self_vote_payout,
                  pending_payout_value: pending_payout_value_NUM
                };
                console.log(" - - self vote obj: " + JSON.stringify(selfVoteObj));

                if (!recordOnly) {
                  console.log(" - - - arranging posts " + queue.length + "...");
                  // add author as the self vote obj is standalone in the
                  // top list
                  selfVoteObj.voter = opDetail.voter;
                  // add flag to mark processing
                  selfVoteObj.processed = "false";
                  if (queue.length >= MAX_POSTS_TO_CONSIDER) {
                    // first sort with lowest first
                    queue.sort(function (a, b) {
                      return a.self_vote_payout - b.self_vote_payout;
                    });
                    var lowestRshare = self_vote_payout;
                    var idx = -1;
                    for (var m = 0; m < queue.length; m++) {
                      if (queue[m].self_vote_payout < self_vote_payout
                        && queue[m].self_vote_payout < self_vote_payout) {
                        lowestRshare = queue[m].self_vote_payout;
                        idx = m;
                      }
                    }
                    if (idx >= 0) {
                      console.log(" - - - removing existing lower rshares" +
                        " post " + queue[idx].permlink + " with payout " + queue[idx].self_vote_payout);
                      var newPosts = [];
                      for (var m = 0; m < queue.length; m++) {
                        if (m != idx) {
                          newPosts.push(queue[m]);
                        }
                      }
                      queue = newPosts;
                      console.log(" - - - keeping " + newPosts.length + " posts");
                    }
                  }

                  if (queue.length < MAX_POSTS_TO_CONSIDER) {
                    console.log(" - - - adding new post to top list");
                    queue.push(selfVoteObj);
                  } else {
                    console.log(" - - - not adding post to top list");
                  }
                }
              }

              wait.for(lib.mongoSave_wrapper, lib.DB_VOTERS, voterInfos);
              console.log("* voter updated: "+JSON.stringify(voterInfos));
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
    console.log("Processed from block "+startAtBlockNum+" to " + currentBlockNum);
    wait.for(lib.mongoSave_wrapper, lib.DB_RUNS,
      {
        start_block: startAtBlockNum,
        end_block: currentBlockNum
      });
    var lastInfos = lib.getLastInfos();
    lastInfos.lastBlock = currentBlockNum;
    wait.for(lib.mongoSave_wrapper, lib.DB_RECORDS, lastInfos);
    lib.setLastInfos(lastInfos);
    // save queue, but drop it first as we are performing an overwrite
    lib.mongo_dropQueue_wrapper();
    for (var i = 0; i < queue.length; i++) {
      wait.for(lib.mongoSave_wrapper, lib.DB_QUEUE, queue[i]);
    }
    // exit
    callback();
  });
}


// START THIS SCRIPT
main();