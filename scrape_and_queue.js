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
  MAX_BLOCKS_PER_RUN = 9000,
  MAX_POSTS_TO_CONSIDER = 100; //default


function main() {
  lib.start(function () {
    if (lib.getLastInfos().blocked) {
      console.log("Day blocked - edit value to unblock");
      return;
    }
    doProcess(lib.getLastInfos().lastBlock + 1, function () {
      console.log("Finished");
    });
  });
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
    var totalVotes = 0;
    var numSelfCommentVotes = 0;
    var numCommentsVotes = 0;
    var numHighSpCommentSelfVotes = 0;
    var numFlagsToCancel = 0;
    var firstBlockMoment = null;
    var currentBlockNum = 0;
    var dayBlocked = false;
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
          dayBlocked = true;
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

              totalVotes++;

              // FIRST, screen for comments only
              var permlinkParts = opDetail.permlink.split("-");
              if (permlinkParts.length === 0
                || !S(permlinkParts[0]).startsWith("re")
                || !S(permlinkParts[permlinkParts.length - 1]).startsWith("201")
                || !S(permlinkParts[permlinkParts.length - 1]).endsWith("z")
                || permlinkParts[permlinkParts.length - 1].indexOf("t") < 0) {
                //console.log("Not a comment, skipping");
                continue;
              }

              numCommentsVotes++;

              // check voter db for same vote
              var voterInfos = wait.for(lib.getVoterFromDb, opDetail.voter);

              // THEN, check vote is a self vote
              if (opDetail.voter.localeCompare(opDetail.author) != 0) {
                continue;
              }

              numSelfCommentVotes++;

              // get post content and rshares of vote
              var content;
              // TODO : cache posts
              content = wait.for(lib.steem_getContent_wrapper, opDetail.author,
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

              // THEN, check if vote rshares are > 0
              // note: cancelled self votes have rshares == 0
              if (voteDetail.rshares < 0) {
                console.log(" - - self flag");
              } else if (voteDetail.rshares === 0) {
                console.log(" - - self vote negated");
              }

              console.log("- self vote at b " + i + ":t " + j + ":op " +
                k + ", detail:" + JSON.stringify(opDetail));

              // THIRD, check payout window still open
              var recordOnly = false;
              var cashoutTime = moment(content.cashout_time);
              cashoutTime.subtract(7, 'hours');
              var nowTime = moment(new Date());
              if (!nowTime.isBefore(cashoutTime)) {
                console.log("payout window now closed, only keep record," +
                  " do not consider for flag");
                recordOnly = true;
              }

              // THEN, check their SP is above minimum
              // TODO : cache user accounts
              var accounts = wait.for(lib.steem_getAccounts_wrapper, opDetail.voter);
              var voterAccount = accounts[0];
              // TODO : take delegated stake into consideration?
              var steemPower = lib.getSteemPowerFromVest(voterAccount.vesting_shares)
                + lib.getSteemPowerFromVest(voterAccount.received_vesting_shares)
                - lib.getSteemPowerFromVest(voterAccount.delegated_vesting_shares);
              if (steemPower < lib.MIN_SP) {
                console.log("SP of "+opDetail.voter+" < min of "+lib.MIN_SP
                  +", skipping");
                continue;
              }

              numHighSpCommentSelfVotes++;

              // consider for flag queue
              console.log("content.pending_payout_value: "+content.pending_payout_value);
              var pending_payout_value = content.pending_payout_value.split(" ");
              var pending_payout_value_NUM = Number(pending_payout_value[0]);
              console.log("content.net_rshares: "+content.net_rshares);
              var self_vote_payout;
              if (pending_payout_value_NUM <= 0.00) {
                self_vote_payout = 0;
              } else if (content.active_votes.length === 1
                  || voteDetail.rshares === Number(content.net_rshares)) {
                self_vote_payout = pending_payout_value_NUM;
              } else {
                self_vote_payout = pending_payout_value_NUM * (voteDetail.rshares / Number(content.net_rshares));
              }
              if (self_vote_payout < 0) {
                self_vote_payout = 0;
              }
              console.log("self_vote_payout: "+self_vote_payout);

              // calculate cumulative extrapolated ROI
              var roi =  0;
              if (self_vote_payout > 0) {
                roi = ((self_vote_payout * 356) / steemPower) * 100;
              }

              // update voter info
              if (voterInfos === null || voterInfos === undefined) {
                voterInfos = {
                  voter: opDetail.voter,
                  total_self_vote_payout: 0.0,
                  total_extrapolated_roi: roi,
                  steem_power: steemPower,
                  comments: [
                      {
                        permlink: content.permlink,
                        extrapolated_roi: roi
                      }
                    ]
                };
              } else {
                voterInfos.total_self_vote_payout = voterInfos.total_self_vote_payout + self_vote_payout;
                voterInfos.steem_power = steemPower;
                voterInfos.total_extrapolated_roi += roi;
                // check for duplicate permlink, if so then update roi
                var isDuplicate = false;
                for (var m = 0; m < voterInfos.comments.length; m++) {
                  if (voterInfos.comments[m].permlink.localeCompare(content.permlink) === 0) {
                    console.log(" - - - new vote is duplicate on top" +
                      " list, replacing value");
                    voterInfos.comments[m].extrapolated_roi = roi;
                    // update total_extrapolated_roi
                    voterInfos.total_extrapolated_roi = 0;
                    for (var n = 0 ; n < voterInfos.comments.length ; n++) {
                      voterInfos.total_extrapolated_roi += voterInfos.comments[n].extrapolated_roi;
                    }
                    isDuplicate = true;
                    break;
                  }
                }
                if (!isDuplicate) {
                  voterInfos.comments.push(
                    {
                      permlink: content.permlink,
                      extrapolated_roi: roi
                    }
                  );
                }
              }
              console.log(" - - updated voter info: "+JSON.parse(voterInfos));

              if (!recordOnly) {
                console.log(" - - - arranging posts " + queue.length + "...");
                if (queue.length >= MAX_POSTS_TO_CONSIDER) {
                  // first sort with lowest first
                  /*
                  queue.sort(function (a, b) {
                    return a.total_extrapolated_roi - b.total_extrapolated_roi;
                  });
                  */

                  var lowest = roi;
                  var idx = -1;
                  for (var m = 0; m < queue.length; m++) {
                    if (queue[m].total_extrapolated_roi < voterInfos.total_extrapolated_roi) {
                      lowest = queue[m].total_extrapolated_roi ;
                      idx = m;
                    }
                  }
                  if (idx >= 0) {
                    console.log(" - - - removing existing lower roi " +
                      " user " + queue[idx].voter + " with total" +
                      " extrapolated roi of " +
                      + queue[idx].total_extrapolated_roi);
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
    console.log("NUM SELF COMMENT VOTES from block "+startAtBlockNum+" to " +
      currentBlockNum + " is "+numSelfCommentVotes + "("+numHighSpCommentSelfVotes+" above min SP"+
      " of "+numCommentsVotes+
      " comments votes, out of " + totalVotes + " total votes");
    console.log(" - "+numFlagsToCancel+" previous flags cancelled");
    wait.for(lib.mongoSave_wrapper, lib.DB_RUNS,
      {
        start_block: startAtBlockNum,
        end_block: currentBlockNum,
        votes_total: totalVotes,
        comment_votes_total: numCommentsVotes,
        comments_selfvotes: numSelfCommentVotes,
        selfvotes_high_sp_comments: numHighSpCommentSelfVotes,
        flags_cancelled: numFlagsToCancel
      });
    var lastInfos = lib.getLastInfos();
    lastInfos.lastBlock = currentBlockNum;
    if (dayBlocked) {
      lastInfos.blocked = true;
    }
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