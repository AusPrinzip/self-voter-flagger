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
  MAX_BLOCKS_PER_RUN = 7000,
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
    // facts from blockchain
    var price_info = wait.for(lib.steem_getCurrentMedianHistoryPrice_wrapper);
    var sbd_per_steem = price_info.base.replace(" SBD", "") / price_info.quote.replace(" STEEM", "");
    // set up vars
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

              // check voter db for same vote
              var voterInfos = wait.for(lib.getVoterFromDb, opDetail.voter);

              // THEN, check vote is a self vote
              if (opDetail.voter.localeCompare(opDetail.author) != 0) {
                continue;
              }

              // check their SP is above minimum
              var accounts = wait.for(lib.steem_getAccounts_wrapper, opDetail.voter);
              var voterAccount = accounts[0];
              var steemPower = lib.getSteemPowerFromVest(voterAccount.vesting_shares)
                + lib.getSteemPowerFromVest(voterAccount.received_vesting_shares)
                - lib.getSteemPowerFromVest(voterAccount.delegated_vesting_shares);
              if (steemPower < lib.MIN_SP) {
                //console.log("SP of "+opDetail.voter+" < min of
                // "+lib.MIN_SP
                  //+", skipping");
                continue;
              }

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

              // check payout window still open
              var recordOnly = false;
              var cashoutTime = moment(content.cashout_time);
              var nowTime = moment(new Date());
              cashoutTime.subtract(7, 'hours');
              if (!nowTime.isBefore(cashoutTime)) {
                console.log("payout window now closed, only keep record," +
                  " do not consider for flag");
                recordOnly = true;
              }

              var voteDetail = null;
              var counted_net_rshares = 0;
              for (var m = 0; m < content.active_votes.length; m++) {
                counted_net_rshares += content.active_votes[m].rshares;
                if (content.active_votes[m].voter.localeCompare(opDetail.voter) == 0) {
                  voteDetail = content.active_votes[m];
                  if (!recordOnly) {
                    break;
                  }
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

              // consider for flag queue
              var max_payout = 0;
              var net_rshares = 0;
              if (!recordOnly) {
                console.log("content.pending_payout_value: "+content.pending_payout_value);
                var pending_payout_value = content.pending_payout_value.split(" ");
                max_payout = Number(pending_payout_value[0]);
                net_rshares = content.net_rshares;
              } else {
                console.log("content.total_payout_value: "+content.total_payout_value);
                var total_payout_value = content.total_payout_value.split(" ");
                max_payout = Number(total_payout_value[0]);
                net_rshares = counted_net_rshares;
              }
              console.log("net_rshares: "+net_rshares);

              var self_vote_payout;
              if (max_payout <= 0.00) {
                self_vote_payout = 0;
              } else if (content.active_votes.length === 1
                  || voteDetail.rshares === Number(net_rshares)) {
                self_vote_payout = max_payout;
              } else {
                self_vote_payout = max_payout * (voteDetail.rshares / Number(net_rshares));
              }
              if (self_vote_payout < 0) {
                self_vote_payout = 0;
              }
              console.log("self_vote_payout: "+self_vote_payout);

              // calculate cumulative extrapolated ROI
              var roi =  0;
              if (self_vote_payout > 0) {
                roi = (self_vote_payout / (steemPower * sbd_per_steem)) * 100;
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
                        self_vote_payout: self_vote_payout,
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
                      self_vote_payout: self_vote_payout,
                      extrapolated_roi: roi
                    }
                  );
                }
              }
              //console.log(" - - updated voter info:
              // "+JSON.stringify(voterInfos));

              if (!recordOnly) {
                //console.log(" - - - arranging users " + queue.length +
                // "...");
                if (queue.length >= MAX_POSTS_TO_CONSIDER) {
                  // first sort with lowest first
                  /*
                  queue.sort(function (a, b) {
                    return a.total_extrapolated_roi - b.total_extrapolated_roi;
                  });
                  */

                  var idx = -1;
                  for (var m = 0; m < queue.length; m++) {
                    if (queue[m].voter.localeCompare(opDetail.voter) === 0) {
                      idx = m;
                      break;
                    }
                  }
                  if (idx < 0) {
                    var lowest = roi;
                    for (var m = 0; m < queue.length; m++) {
                      if (queue[m].total_extrapolated_roi < voterInfos.total_extrapolated_roi) {
                        lowest = queue[m].total_extrapolated_roi ;
                        idx = m;
                      }
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
                    console.log(" - - - keeping " + queue.length + " queue");
                  }
                }

                if (queue.length < MAX_POSTS_TO_CONSIDER) {
                  console.log(" - - - adding user to top list");
                  queue.push(voterInfos);
                } else {
                  console.log(" - - - not adding post to top list");
                }
              }

              wait.for(lib.mongoSave_wrapper, lib.DB_VOTERS, voterInfos);
              //console.log("* voter updated: "+JSON.stringify(voterInfos));
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
    if (dayBlocked) {
      lastInfos.blocked = true;
    }
    wait.for(lib.mongoSave_wrapper, lib.DB_RECORDS, lastInfos);
    lib.setLastInfos(lastInfos);
    // save queue, but drop it first as we are performing an overwrite
    lib.mongo_dropQueue_wrapper();
    wait.for(lib.timeout_wrapper, 200);
    console.log(" - saving queue of length " + queue.length);
    for (var i = 0; i < queue.length; i++) {
      wait.for(lib.mongoSave_wrapper, lib.DB_QUEUE, queue[i]);
    }
    // exit
    callback();
  });
}


// START THIS SCRIPT
main();