'use strict';

const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');
const lib = require('./lib.js');

var MAX_MINS_TO_RUN = 5;
var MAX_POSTS_TO_CONSIDER = 20; // default

function main () {
  lib.start(function () {
    if (lib.getLastInfos().blocked) {
      console.log('Day blocked - edit value to unblock');
      setTimeout(function () {
        process.exit();
      }, 5000);
      return;
    }
    doProcess(lib.getLastInfos().lastBlock + 1, function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

var queue = [];

function doProcess (startAtBlockNum, callback) {
  wait.launchFiber(function () {
    // get queue
    queue = wait.for(lib.getAllQueue);
    if (queue === undefined ||
        queue === null) {
      queue = [];
    }
    // facts from blockchain
    try {
      var priceInfo = wait.for(lib.steem_getCurrentMedianHistoryPrice_wrapper);
    } catch (err) {
      console.log('Couldnt get price info, aborting');
      callback();
      return;
    }
    var sbdPerSteem = priceInfo.base.replace(' SBD', '') / priceInfo.quote.replace(' STEEM', '');
    // set up vars
    var firstBlockMoment = null;
    var currentBlockNum = 0;
    var dayBlocked = false;
    var endTime = moment(new Date()).add(MAX_MINS_TO_RUN, 'minute');
    for (var i = startAtBlockNum; i <= lib.getProperties().head_block_number; i++) {
      if (moment(new Date()).isAfter(endTime)) {
        console.log('Max time reached, stopping');
        currentBlockNum--;
        break;
      }
      currentBlockNum = i;
      try {
        var block = wait.for(lib.steem_getBlock_wrapper, i);
      } catch (err) {
        console.log('Getting block failed, finish gravefully');
        finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
          callback();
        });
        return;
      }
      // create current time moment from block infos
      var latestBlockMoment = moment(block.timestamp, moment.ISO_8601);
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
      // console.log("block info: "+JSON.stringify(block));
      var transactions = block.transactions;
      for (var j = 0; j < transactions.length; j++) {
        var transaction = transactions[j];
        for (var k = 0; k < transaction.operations.length; k++) {
          var opName = transaction.operations[k][0];
          var opDetail = transaction.operations[k][1];
          if (opName !== undefined && opName !== null &&
            opName.localeCompare('vote') === 0) {
            // process all posts, not just comments
            /*
            var permlinkParts = opDetail.permlink.split("-");
            if (permlinkParts.length === 0
              || !S(permlinkParts[0]).startsWith("re")
              || !S(permlinkParts[permlinkParts.length - 1]).startsWith("201")
              || !S(permlinkParts[permlinkParts.length - 1]).endsWith("z")
              || permlinkParts[permlinkParts.length - 1].indexOf("t") < 0) {
              //console.log("Not a comment, skipping");
              continue;
            }
            */

            // try to get voter info from db
            var voterInfos = wait.for(lib.getVoterFromDb, opDetail.voter);

            // THEN, check vote is a self vote
            if (opDetail.voter.localeCompare(opDetail.author) !== 0) {
              continue;
            }

            // check their SP is above minimum
            try {
              var accounts = wait.for(lib.steem_getAccounts_wrapper, opDetail.voter);
            } catch (err) {
              console.log('Get accounts for voter failed, finish gracefully');
              finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
                callback();
              });
              return;
            }
            var voterAccount = accounts[0];
            try {
              var steemPower = lib.getSteemPowerFromVest(voterAccount.vesting_shares) +
                  lib.getSteemPowerFromVest(voterAccount.received_vesting_shares) -
                  lib.getSteemPowerFromVest(voterAccount.delegated_vesting_shares);
            } catch (err) {
              console.log('Get vesting shares for voter failed, finish gracefully');
              finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
                callback();
              });
              return;
            }
            if (steemPower < lib.MIN_SP) {
              // console.log("SP of "+opDetail.voter+" < min of
              // "+lib.MIN_SP
                // +", skipping");
              continue;
            }

            // get post content and rshares of vote
            var content;
            try {
              content = wait.for(lib.steem_getContent_wrapper, opDetail.author, opDetail.permlink);
            } catch (err) {
              console.log('Get post content failed, finish gracefully');
              finishAndStoreLastInfos(startAtBlockNum, currentBlockNum - 1, dayBlocked, function () {
                callback();
              });
              return;
            }
            if (content === undefined || content === null) {
              console.log('Couldnt process operation, continuing.' +
                ' Error: post content response not defined');
              continue;
            }

            // check payout window still open
            var recordOnly = false;
            var cashoutTime = moment(content.cashout_time);
            var nowTime = moment(new Date());
            cashoutTime.subtract(7, 'hours');
            if (!nowTime.isBefore(cashoutTime)) {
              console.log('payout window now closed, only keep record,' +
                  ' do not consider for flag');
              recordOnly = true;
            }

            var voteDetail = null;
            var countedNetRshares = 0;
            for (var m = 0; m < content.active_votes.length; m++) {
              countedNetRshares += content.active_votes[m].rshares;
              if (content.active_votes[m].voter.localeCompare(opDetail.voter) === 0) {
                voteDetail = content.active_votes[m];
                if (!recordOnly) {
                  break;
                }
              }
            }
            if (voteDetail === null) {
              console.log('vote details null, cannot process, skip');
              continue;
            }

            // THEN, check if vote rshares are > 0
            // note: cancelled self votes have rshares == 0
            if (voteDetail.rshares < 0) {
              console.log(' - - self flag');
            } else if (voteDetail.rshares === 0) {
              console.log(' - - self vote negated');
            }

            console.log('- self vote at b ' + i + ':t ' + j + ':op ' +
              k + ', detail:' + JSON.stringify(opDetail));

            // consider for flag queue
            var maxPayout = 0;
            var netRshares = 0;
            if (!recordOnly) {
              console.log('content.pending_payout_value: ' + content.pending_payout_value);
              var pendingPayoutValue = content.pending_payout_value.split(' ');
              maxPayout = Number(pendingPayoutValue[0]);
              netRshares = content.net_rshares;
            } else {
              console.log('content.total_payout_value: ' + content.total_payout_value);
              var totalPayoutValue = content.total_payout_value.split(' ');
              maxPayout = Number(totalPayoutValue[0]);
              netRshares = countedNetRshares;
            }
            console.log('netRshares: ' + netRshares);

            var selfVotePayout;
            if (maxPayout <= 0.00) {
              selfVotePayout = 0;
            } else if (content.active_votes.length === 1 ||
                  voteDetail.rshares === Number(netRshares)) {
              selfVotePayout = maxPayout;
            } else {
              selfVotePayout = maxPayout * (voteDetail.rshares / Number(netRshares));
            }
            if (selfVotePayout < 0) {
              selfVotePayout = 0;
            }
            console.log('selfVotePayout: ' + selfVotePayout);

            // calculate cumulative extrapolated ROI
            var roi = 0;
            if (selfVotePayout > 0) {
              roi = (selfVotePayout / (steemPower * sbdPerSteem)) * 100;
            }
            // cap at 10^(-20) precision to avoid exponent form
            roi = Number(roi.toFixed(20));

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
                    self_vote_payout: selfVotePayout,
                    extrapolated_roi: roi
                  }
                ]
              };
            } else {
              voterInfos.total_self_vote_payout = voterInfos.total_self_vote_payout + selfVotePayout;
              voterInfos.steem_power = steemPower;
              voterInfos.total_extrapolated_roi += roi;
              // check for duplicate permlink, if so then update roi
              var isDuplicate = false;
              for (m = 0; m < voterInfos.comments.length; m++) {
                if (voterInfos.comments[m].permlink.localeCompare(content.permlink) === 0) {
                  console.log(' - - - new vote is duplicate on top list, replacing value');
                  voterInfos.comments[m].extrapolated_roi = roi;
                  // update total_extrapolated_roi
                  voterInfos.total_extrapolated_roi = 0;
                  for (var n = 0; n < voterInfos.comments.length; n++) {
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
                    self_vote_payout: selfVotePayout,
                    extrapolated_roi: roi
                  }
                );
              }
            }
            // console.log(" - - updated voter info:
            // "+JSON.stringify(voterInfos));

            if (!recordOnly) {
              // console.log(" - - - arranging users " + queue.length +
              // "...");
              if (queue.length >= MAX_POSTS_TO_CONSIDER) {
                // first sort with lowest first
                /*
                queue.sort(function (a, b) {
                  return a.total_extrapolated_roi - b.total_extrapolated_roi;
                });
                */

                var idx = -1;
                for (m = 0; m < queue.length; m++) {
                  if (queue[m].voter.localeCompare(opDetail.voter) === 0) {
                    idx = m;
                    break;
                  }
                }
                if (idx < 0) {
                  var lowest = roi;
                  for (m = 0; m < queue.length; m++) {
                    if (queue[m].total_extrapolated_roi < lowest) {
                      lowest = queue[m].total_extrapolated_roi;
                      idx = m;
                    }
                  }
                }

                if (idx >= 0) {
                  console.log(' - - - removing existing lower roi user ' +
                      queue[idx].voter + ' with total extrapolated roi of ' +
                      queue[idx].total_extrapolated_roi);
                  var newPosts = [];
                  for (m = 0; m < queue.length; m++) {
                    if (m !== idx) {
                      newPosts.push(queue[m]);
                    }
                  }
                  queue = newPosts;
                  console.log(' - - - keeping ' + queue.length + ' queue');
                }
              }

              if (queue.length < MAX_POSTS_TO_CONSIDER) {
                console.log(' - - - adding user to top list');
                queue.push(voterInfos);
              } else {
                console.log(' - - - not adding post to top list');
              }
            }

            wait.for(lib.mongoSave_wrapper, lib.DB_VOTERS, voterInfos);
            // console.log("* voter updated: "+JSON.stringify(voterInfos));
          }
        }
      }
    }
    finishAndStoreLastInfos(startAtBlockNum, currentBlockNum, dayBlocked, function () {
      callback();
    });
  });
}

function finishAndStoreLastInfos (startAtBlockNum, currentBlockNum, dayBlocked, callback) {
  console.log('Processed from block ' + startAtBlockNum + ' to ' + currentBlockNum);
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
  console.log(' - saving queue of length ' + queue.length);
  for (var i = 0; i < queue.length; i++) {
    wait.for(lib.mongoSave_wrapper, lib.DB_QUEUE, queue[i]);
  }
  callback();
}

// START THIS SCRIPT
main();
